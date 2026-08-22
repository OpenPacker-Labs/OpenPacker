import {
  canonicalBytes,
  canonicalDigest,
  formatDigest,
  parseCanonicalJson,
  sha256,
} from '@openpacker/canonical';
import type {
  Digest,
  JsonValue,
  PackageInstance,
  SemanticLoss,
  SourceSnapshot,
} from '@openpacker/contracts';
import {
  compareCodePoints,
  ProviderError,
  type CatalogProvider,
  type ProviderRecord,
  type TranslationProvenance,
} from '@openpacker/adapter-core';

export interface CatalogRecord {
  key: string;
  package: PackageInstance;
  rawMetadata: JsonValue;
  rawMetadataDigest: Digest;
  provenance: TranslationProvenance;
  semanticLoss: readonly SemanticLoss[];
  recordDigest: Digest;
}

export interface CatalogSnapshotBundle {
  bundleVersion: 'openpacker-catalog-v1';
  snapshot: SourceSnapshot;
  records: readonly CatalogRecord[];
  bundleDigest: Digest;
}

export type PendingRecord = Omit<
  CatalogRecord,
  'rawMetadataDigest' | 'recordDigest'
> & { rawBytes?: Uint8Array };

// SAFETY: The surrounding boundary establishes the asserted domain contract.
const jsonValue = (value: unknown): JsonValue => value as JsonValue;

export class CatalogSnapshotBuilder {
  readonly #records = new Map<string, PendingRecord>();

  constructor(
    private readonly providerId: string,
    private readonly providerType: string,
    private readonly endpointIdentity: string,
    private readonly retrievedAt: string,
    private readonly evaluationTime: string,
    private readonly revision?: string,
    private readonly etag?: string,
  ) {}

  add(input: PendingRecord): this {
    const existing = this.#records.get(input.key);
    if (existing && canonicalText(existing) !== canonicalText(input))
      throw new ProviderError(
        'SNAPSHOT_MISMATCH',
        `Conflicting catalog record: ${input.key}`,
      );
    this.#records.set(input.key, input);
    return this;
  }

  addProviderRecord(input: {
    record: ProviderRecord;
    package: PackageInstance;
    rawMetadata: JsonValue;
    provenance: TranslationProvenance;
    semanticLoss?: readonly SemanticLoss[];
  }): this {
    const exactPurl = input.package.identity.exactPurl;
    if (!exactPurl)
      throw new ProviderError(
        'INVALID_PROVIDER_METADATA',
        `Catalog package from ${input.record.key} has no exact PURL`,
      );
    return this.add({
      key: exactPurl,
      package: input.package,
      rawMetadata: input.rawMetadata,
      rawBytes: input.record.rawBody,
      provenance: input.provenance,
      semanticLoss: input.semanticLoss ?? input.package.semanticLoss,
    });
  }

  async build(): Promise<CatalogSnapshotBundle> {
    const records: CatalogRecord[] = [];
    for (const input of [...this.#records.values()].sort((left, right) =>
      compareCodePoints(left.key, right.key),
    )) {
      const rawMetadataDigest =
        input.rawBytes === undefined
          ? await canonicalDigest(input.rawMetadata)
          : await sha256(input.rawBytes);
      const payload = {
        key: input.key,
        package: input.package,
        rawMetadata: input.rawMetadata,
        rawMetadataDigest,
        provenance: input.provenance,
        semanticLoss: input.semanticLoss,
      };
      records.push({
        ...payload,
        recordDigest: await canonicalDigest(jsonValue(payload)),
      });
    }
    const recordIndex = records.map((record) => ({
      key: record.key,
      digest: record.recordDigest,
    }));
    const recordsDigest = await canonicalDigest(jsonValue(recordIndex));
    const snapshotPayload = {
      providerId: this.providerId,
      providerType: this.providerType,
      endpointIdentity: this.endpointIdentity,
      retrievedAt: this.retrievedAt,
      evaluationTime: this.evaluationTime,
      ...(!(this.revision === undefined) && { revision: this.revision }),
      ...(!(this.etag === undefined) && { etag: this.etag }),
      recordsDigest,
    };
    const rootDigest = await canonicalDigest(jsonValue(snapshotPayload));
    const snapshot: SourceSnapshot = {
      snapshotId: formatDigest(rootDigest),
      ...snapshotPayload,
      rootDigest,
      evidenceRefs: [],
    };
    const bundlePayload = {
      bundleVersion: 'openpacker-catalog-v1' as const,
      snapshot,
      records,
    };
    return {
      ...bundlePayload,
      bundleDigest: await canonicalDigest(jsonValue(bundlePayload)),
    };
  }
}

export async function captureCatalogSnapshot(
  provider: CatalogProvider,
  exactPurls: readonly string[],
  evaluationTime: string,
  signal?: AbortSignal,
): Promise<CatalogSnapshotBundle> {
  const inspections = [];
  for (const exactPurl of [...new Set(exactPurls)].sort()) {
    if (signal?.aborted)
      throw (
        signal.reason ??
        new ProviderError('CANCELLED', 'Catalog capture cancelled')
      );
    inspections.push(await provider.inspect(exactPurl, signal));
  }
  const source = await provider.snapshot(evaluationTime, signal);
  const builder = new CatalogSnapshotBuilder(
    source.providerId,
    source.providerType,
    source.endpointIdentity,
    source.retrievedAt,
    source.evaluationTime,
    source.revision,
    source.etag,
  );
  for (const inspection of inspections) {
    builder.addProviderRecord({
      record: inspection.record,
      package: inspection.package,
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      rawMetadata: inspection.record.body as JsonValue,
      provenance: {
        providerId: source.providerId,
        endpoint: inspection.record.endpoint,
        retrievedAt: inspection.record.retrievedAt,
        evaluationTime: source.evaluationTime,
        ...(!(inspection.record.etag === undefined) && {
          etag: inspection.record.etag,
        }),
        ...(!(inspection.record.revision === undefined) && {
          revision: inspection.record.revision,
        }),
        snapshotDigest: source.rootDigest,
        metadataDigest: inspection.package.metadataDigest,
      },
      semanticLoss: inspection.package.semanticLoss,
    });
  }
  return builder.build();
}

export class InMemoryCatalogStore {
  readonly #bundles = new Map<string, Uint8Array>();

  async put(bundle: CatalogSnapshotBundle): Promise<void> {
    await verifyCatalogSnapshot(bundle);
    const key = formatDigest(bundle.snapshot.rootDigest);
    const bytes = canonicalBytes(jsonValue(bundle));
    const existing = this.#bundles.get(key);
    if (existing && !equalBytes(existing, bytes))
      throw new ProviderError(
        'SNAPSHOT_MISMATCH',
        `Digest collision or mutable snapshot: ${key}`,
      );
    this.#bundles.set(key, bytes);
  }

  get(digest: string): CatalogSnapshotBundle | undefined {
    const bytes = this.#bundles.get(digest);
    return bytes === undefined
      ? undefined
      : // SAFETY: The surrounding boundary establishes the asserted domain contract.
        parseCanonicalJson<CatalogSnapshotBundle>(
          new TextDecoder().decode(bytes),
        );
  }

  export(digest: string): Uint8Array {
    const bytes = this.#bundles.get(digest);
    if (!bytes)
      throw new ProviderError(
        'SNAPSHOT_NOT_FOUND',
        `Unknown catalog snapshot: ${digest}`,
      );
    return bytes.slice();
  }

  async import(bytes: Uint8Array): Promise<CatalogSnapshotBundle> {
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const bundle = parseCanonicalJson<CatalogSnapshotBundle>(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    );
    await this.put(bundle);
    return bundle;
  }
}

export async function verifyCatalogSnapshot(
  bundle: CatalogSnapshotBundle,
): Promise<void> {
  const sorted = [...bundle.records].sort((left, right) =>
    compareCodePoints(left.key, right.key),
  );
  if (sorted.some((record, index) => record.key !== bundle.records[index]?.key))
    throw new ProviderError(
      'SNAPSHOT_MISMATCH',
      'Catalog records are not canonically sorted',
    );
  for (const record of bundle.records) {
    const { recordDigest, ...payload } = record;
    const actual = await canonicalDigest(jsonValue(payload));
    if (formatDigest(actual) !== formatDigest(recordDigest))
      throw new ProviderError(
        'SNAPSHOT_MISMATCH',
        `Record digest mismatch: ${record.key}`,
      );
  }
  const recordsDigest = await canonicalDigest(
    jsonValue(
      bundle.records.map((record) => ({
        key: record.key,
        digest: record.recordDigest,
      })),
    ),
  );
  if (
    formatDigest(recordsDigest) !== formatDigest(bundle.snapshot.recordsDigest)
  )
    throw new ProviderError(
      'SNAPSHOT_MISMATCH',
      'Record-index digest mismatch',
    );
  const {
    snapshotId: _snapshotId,
    rootDigest: _rootDigest,
    evidenceRefs: _evidenceRefs,
    authenticationScopeRef: _authenticationScopeRef,
    extensions: _extensions,
    ...snapshotPayload
  } = bundle.snapshot;
  const rootDigest = await canonicalDigest(jsonValue(snapshotPayload));
  if (
    formatDigest(rootDigest) !== bundle.snapshot.snapshotId ||
    formatDigest(rootDigest) !== formatDigest(bundle.snapshot.rootDigest)
  ) {
    throw new ProviderError(
      'SNAPSHOT_MISMATCH',
      'Snapshot root digest mismatch',
    );
  }
  const { bundleDigest: _bundleDigest, ...bundlePayload } = bundle;
  const bundleDigest = await canonicalDigest(jsonValue(bundlePayload));
  if (formatDigest(bundleDigest) !== formatDigest(bundle.bundleDigest))
    throw new ProviderError('SNAPSHOT_MISMATCH', 'Bundle digest mismatch');
}

function canonicalText(value: unknown): string {
  return new TextDecoder().decode(canonicalBytes(jsonValue(value)));
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength &&
    left.every((byte, index) => byte === right[index])
  );
}
