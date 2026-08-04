import { canonicalDigest, formatDigest, sha256 } from '@openpacker/canonical';
import type {
  ArtifactDescriptor,
  JsonValue,
  PackageIdentity,
  PackageInstance,
  Requirement,
  SemanticLoss,
  SourceSnapshot,
  VersionConstraint,
} from '@openpacker/contracts';
import {
  compareParsedVersions,
  compareCodePoints,
  evaluateSemverRange,
  formatPurl,
  header,
  packageNodeId,
  parsePurl,
  parseSemver,
  parseSemverRange,
  ProviderError,
  providerErrorForStatus,
  rangeToConstraint,
  semanticLoss,
  sourceRef,
  text,
  verifyNativeDigest,
  assertBoundedProviderMetadata,
  type CatalogProvider,
  type Clock,
  type EcosystemCodec,
  type HttpTransport,
  type LockCapture,
  type NativeCoordinate,
  type ParsedRange,
  type ParsedVersion,
  type ProviderCapabilities,
  type ProviderInspection,
  type ProviderRecord,
  type TranslatedMetadata,
  type TranslationProvenance,
} from '@openpacker/adapter-core';

export interface CargoDependency {
  name: string;
  req: string;
  features?: string[];
  optional?: boolean;
  default_features?: boolean;
  target?: string | null;
  kind?: 'normal' | 'dev' | 'build' | null;
  package?: string;
  registry?: string | null;
}

export interface CargoIndexRecord {
  name: string;
  vers: string;
  deps: CargoDependency[];
  cksum: string;
  features: Record<string, string[]>;
  features2?: Record<string, string[]>;
  yanked?: boolean;
  links?: string;
  rust_version?: string;
  size?: number;
  v?: number;
}

export interface CargoLockPackage {
  name: string;
  version: string;
  source?: string;
  checksum?: string;
  dependencies?: string[];
}

export interface CargoLockDocument {
  version: number;
  packages: CargoLockPackage[];
}

function cargoIdentity(exactPurl: string, endpoint?: string): PackageIdentity {
  const parsed = parsePurl(exactPurl);
  const identity: PackageIdentity = {
    canonicalPurl: formatPurl({ ...parsed, version: undefined }),
    purlType: 'cargo',
    name: parsed.name,
    qualifiers: { ...parsed.qualifiers },
    nativeCoordinates: [
      {
        ecosystem: 'cargo',
        coordinate: parsed.name,
        ...(parsed.version === undefined ? {} : { version: parsed.version }),
      },
    ],
    aliases: [],
    sourceRefs: endpoint === undefined ? [] : [sourceRef('cargo', endpoint)],
    publisherRefs: [],
    externalRefs: [],
  };
  if (parsed.version !== undefined) {
    identity.version = parsed.version;
    identity.exactPurl = formatPurl(parsed);
  }
  return identity;
}

function cargoKind(kind: CargoDependency['kind']): Requirement['kind'] {
  return kind === 'build'
    ? 'build'
    : kind === 'dev'
      ? 'development'
      : 'runtime';
}

function targetExpression(
  target: string | null | undefined,
  expression: Requirement['expression'],
): Requirement['expression'] {
  if (!target) return expression;
  const match = /^cfg\(target_(os|arch)\s*=\s*"([A-Za-z0-9_.-]+)"\)$/.exec(
    target,
  );
  if (!match) return expression;
  return {
    type: 'conditional',
    when: {
      type: 'equals',
      path: match[1] === 'arch' ? 'architecture' : 'os',
      value: match[2]!,
    },
    then: expression,
  };
}

export class CargoCodec
  implements EcosystemCodec<CargoIndexRecord, CargoLockDocument | string>
{
  readonly purlType = 'cargo' as const;

  parseNativeCoordinate(value: string): NativeCoordinate {
    const match = /^([A-Za-z0-9_-]+)(?:@(.+))?$/.exec(value.trim());
    if (!match)
      throw new ProviderError(
        'INVALID_NATIVE_COORDINATE',
        `Invalid Cargo coordinate: ${value}`,
      );
    return {
      ecosystem: 'cargo',
      name: match[1]!.toLowerCase(),
      original: value,
      ...(match[2] === undefined ? {} : { version: match[2] }),
    };
  }

  canonicalizePurl(value: string): string {
    const parsed = parsePurl(value);
    if (parsed.type !== 'cargo' || parsed.namespace !== undefined)
      throw new ProviderError(
        'INVALID_PURL',
        'Cargo PURLs do not have namespaces',
      );
    return formatPurl({
      ...parsed,
      name: parsed.name.toLowerCase(),
      ...(parsed.version === undefined
        ? {}
        : { version: this.parseNativeVersion(parsed.version).normalized }),
    });
  }

  parseNativeVersion(value: string): ParsedVersion {
    return parseSemver(value, 3);
  }

  compareNativeVersions(left: string, right: string): number {
    return compareParsedVersions(
      this.parseNativeVersion(left),
      this.parseNativeVersion(right),
    );
  }

  parseNativeRange(value: string): ParsedRange {
    return parseSemverRange(value, {
      scheme: 'cargo',
      bare: 'caret',
      commaAnd: true,
    });
  }

  toVers(value: string): VersionConstraint {
    return rangeToConstraint(this.parseNativeRange(value));
  }

  satisfies(version: string, range: string | ParsedRange): boolean {
    return evaluateSemverRange(
      version,
      typeof range === 'string' ? this.parseNativeRange(range).ast : range.ast,
      (left, right) => this.compareNativeVersions(left, right),
    );
  }

  async translateMetadata(
    metadata: CargoIndexRecord,
    provenance: TranslationProvenance,
  ): Promise<TranslatedMetadata> {
    const exactPurl = this.canonicalizePurl(
      `pkg:cargo/${encodeURIComponent(metadata.name)}@${encodeURIComponent(metadata.vers)}`,
    );
    const nodeId = await packageNodeId({
      exactPurl,
      nativeSemanticsVersion: 'cargo-v1',
    });
    const requirements: Requirement[] = metadata.deps
      .map((dependency, index) => {
        const name = (dependency.package ?? dependency.name).toLowerCase();
        const range = this.parseNativeRange(dependency.req);
        const expression: Requirement['expression'] = {
          type: 'package',
          purl: `pkg:cargo/${encodeURIComponent(name)}`,
          ...(range.vers === undefined ? {} : { vers: range.vers }),
        };
        const targetLoss =
          dependency.target &&
          !/^cfg\(target_(os|arch)\s*=/.test(dependency.target)
            ? [
                semanticLoss(
                  'cargo',
                  'CARGO_CFG_PRESERVED_NATIVE',
                  `/deps/${index}/target`,
                  `Cargo cfg expression ${dependency.target} is preserved for a native validator`,
                  undefined,
                  'error',
                ),
              ]
            : [];
        return {
          id: `${nodeId}:${cargoKind(dependency.kind)}:${dependency.name}:${index}`,
          dependerNodeId: nodeId,
          expression: targetExpression(dependency.target, expression),
          kind: cargoKind(dependency.kind),
          optional: dependency.optional ?? false,
          source: sourceRef('cargo', provenance.endpoint),
          authority: 'native',
          raw: dependency as unknown as JsonValue,
          nativeSemantics: {
            version: 'cargo-v1',
            data: {
              features: dependency.features ?? [],
              defaultFeatures: dependency.default_features ?? true,
              target: dependency.target ?? null,
              registry: dependency.registry ?? null,
              ...(dependency.package === undefined
                ? {}
                : { renamedFrom: dependency.package }),
            } as JsonValue,
          },
          semanticLoss: [...range.semanticLoss, ...targetLoss],
        } satisfies Requirement;
      })
      .sort((left, right) => compareCodePoints(left.id, right.id));
    const losses: SemanticLoss[] = [];
    if (
      Object.keys(metadata.features).length > 0 ||
      Object.keys(metadata.features2 ?? {}).length > 0
    ) {
      losses.push(
        semanticLoss(
          'cargo',
          'CARGO_FEATURE_UNIFICATION_NATIVE',
          '/features',
          'Cargo feature activation and resolver-version unification are retained in nativeSemantics',
          'Optional dependency edges are represented directly',
        ),
      );
    }
    const artifacts: ArtifactDescriptor[] = [];
    if (/^[0-9a-f]{64}$/.test(metadata.cksum) && metadata.size !== undefined) {
      artifacts.push({
        descriptorId: `${nodeId}:crate`,
        digest: { algorithm: 'sha256', value: metadata.cksum },
        size: metadata.size,
        mediaType: 'application/gzip',
        artifactType: 'application/vnd.openpacker.cargo.crate.v1+tar',
        fileName: `${metadata.name}-${metadata.vers}.crate`,
        nativeRole: 'package-archive',
        locations: [],
        referrers: [],
        externalRefs: [],
      });
    } else if (metadata.size === undefined) {
      losses.push(
        semanticLoss(
          'cargo',
          'CARGO_ARCHIVE_SIZE_NOT_IN_INDEX',
          '/size',
          'Sparse index records supply the archive checksum but not its byte length',
        ),
      );
    }
    const instance: PackageInstance = {
      nodeId,
      identity: cargoIdentity(exactPurl, provenance.endpoint),
      nativeVersion: metadata.vers,
      normalizedVersion: this.parseNativeVersion(metadata.vers).normalized,
      versionSortKey: this.parseNativeVersion(metadata.vers).normalized,
      requirements,
      capabilities: [],
      conflicts: [],
      cardinalityConstraints: [],
      artifacts,
      lifecycle: {
        status: metadata.yanked ? 'yanked' : 'published',
        eligible: !metadata.yanked,
        warnings: metadata.yanked
          ? [
              {
                code: 'CARGO_YANKED',
                message: 'Version is yanked in the registry index',
              },
            ]
          : [],
      },
      sourceSnapshots:
        provenance.snapshotDigest === undefined
          ? []
          : [provenance.snapshotDigest],
      metadataDigest: provenance.metadataDigest,
      nativeSemantics: {
        version: 'cargo-v1',
        data: {
          features: metadata.features,
          features2: metadata.features2 ?? {},
          ...(metadata.links === undefined ? {} : { links: metadata.links }),
          ...(metadata.rust_version === undefined
            ? {}
            : { rustVersion: metadata.rust_version }),
          indexSchemaVersion: metadata.v ?? 1,
          checksum: metadata.cksum,
          buildAndProcMacroCodeExecuted: false,
        } as JsonValue,
      },
      semanticLoss: losses,
    };
    if (provenance.rawMetadataRef !== undefined)
      instance.rawMetadataRef = provenance.rawMetadataRef;
    return { instance, rawMetadata: metadata };
  }

  translateLockResult(
    lockInput: CargoLockDocument | string,
    provenance: TranslationProvenance,
  ): LockCapture {
    const lock =
      typeof lockInput === 'string' ? parseCargoLock(lockInput) : lockInput;
    const packages = lock.packages
      .map((entry) => ({
        exactPurl: this.canonicalizePurl(
          `pkg:cargo/${encodeURIComponent(entry.name)}@${encodeURIComponent(entry.version)}`,
        ),
        nativeCoordinate: `${entry.name}@${entry.version}`,
        ...(entry.source === undefined ? {} : { resolved: entry.source }),
        ...(entry.checksum === undefined
          ? {}
          : { artifactDigest: `sha256:${entry.checksum}` }),
        dependencies: Object.fromEntries(
          (entry.dependencies ?? []).map((dependency) => [
            dependency,
            'locked',
          ]),
        ),
        native: entry,
      }))
      .sort((left, right) =>
        compareCodePoints(left.exactPurl, right.exactPurl),
      );
    return {
      format: 'Cargo.lock',
      formatVersion: String(lock.version),
      sourceDigest: formatDigest(provenance.metadataDigest),
      packages,
      semanticLoss: [],
    };
  }
}

export function parseCargoLock(input: string): CargoLockDocument {
  const versionMatch = /^version\s*=\s*(\d+)\s*$/m.exec(input);
  if (!versionMatch)
    throw new ProviderError(
      'INVALID_LOCKFILE',
      'Cargo.lock is missing a version',
    );
  const packages = input
    .split(/^\[\[package\]\]\s*$/m)
    .slice(1)
    .map((block) => {
      const field = (name: string): string | undefined =>
        new RegExp(`^${name}\\s*=\\s*"([^"]*)"\\s*$`, 'm').exec(block)?.[1];
      const name = field('name');
      const packageVersion = field('version');
      if (!name || !packageVersion)
        throw new ProviderError(
          'INVALID_LOCKFILE',
          'Cargo.lock package is missing name or version',
        );
      const dependenciesBlock = /^dependencies\s*=\s*\[([\s\S]*?)\]\s*$/m.exec(
        block,
      )?.[1];
      const dependencies =
        dependenciesBlock === undefined
          ? undefined
          : [...dependenciesBlock.matchAll(/"([^"]+)"/g)].map(
              (match) => match[1]!,
            );
      const source = field('source');
      const checksum = field('checksum');
      return {
        name,
        version: packageVersion,
        ...(source === undefined ? {} : { source }),
        ...(checksum === undefined ? {} : { checksum }),
        ...(dependencies === undefined ? {} : { dependencies }),
      };
    });
  return { version: Number(versionMatch[1]), packages };
}

export function sparseIndexPath(name: string): string {
  const normalized = name.toLowerCase();
  if (normalized.length === 1) return `1/${normalized}`;
  if (normalized.length === 2) return `2/${normalized}`;
  if (normalized.length === 3) return `3/${normalized[0]}/${normalized}`;
  return `${normalized.slice(0, 2)}/${normalized.slice(2, 4)}/${normalized}`;
}

export class CargoSparseProvider implements CatalogProvider {
  readonly providerId = 'cargo-sparse';
  readonly capabilities: ProviderCapabilities = {
    operations: ['identify', 'enumerate', 'inspect', 'artifact', 'snapshot'],
    purlTypes: ['cargo'],
    qualifierSupport: 'complete',
    targetSpecificSemantics: true,
    offlineReplay: true,
    extensions: { 'openpacker.dev/cargo-index-schema': [1, 2] },
  };
  readonly #records = new Map<
    string,
    ProviderRecord<readonly CargoIndexRecord[]>
  >();

  constructor(
    private readonly transport: HttpTransport,
    private readonly clock: Clock,
    private readonly endpoint = 'https://index.crates.io',
    private readonly downloadEndpoint = 'https://static.crates.io/crates',
    private readonly codec = new CargoCodec(),
  ) {}

  async identify(query: string): Promise<readonly PackageIdentity[]> {
    const purl = query.startsWith('pkg:')
      ? this.codec.canonicalizePurl(query)
      : this.purlFor(this.codec.parseNativeCoordinate(query));
    return [cargoIdentity(purl, this.endpoint)];
  }

  invalidate(purl?: string): void {
    if (purl === undefined) this.#records.clear();
    else {
      const parsed = parsePurl(this.codec.canonicalizePurl(purl));
      this.#records.delete(formatPurl({ ...parsed, version: undefined }));
    }
  }

  async enumerate(
    basePurl: string,
    signal?: AbortSignal,
  ): Promise<readonly string[]> {
    const record = await this.indexRecord(basePurl, signal);
    return [...record.body]
      .sort((left, right) =>
        this.codec.compareNativeVersions(left.vers, right.vers),
      )
      .map((entry) =>
        this.codec.canonicalizePurl(
          `${this.codec.canonicalizePurl(basePurl)}@${entry.vers}`,
        ),
      );
  }

  async inspect(
    exactPurl: string,
    signal?: AbortSignal,
  ): Promise<ProviderInspection> {
    const canonical = this.codec.canonicalizePurl(exactPurl);
    const parsed = parsePurl(canonical);
    if (!parsed.version)
      throw new ProviderError(
        'VERSION_NOT_FOUND',
        'inspect requires an exact Cargo PURL',
      );
    const record = await this.indexRecord(
      formatPurl({ ...parsed, version: undefined }),
      signal,
    );
    const metadata = record.body.find(
      (entry) =>
        this.codec.compareNativeVersions(entry.vers, parsed.version!) === 0,
    );
    if (!metadata)
      throw new ProviderError(
        'VERSION_NOT_FOUND',
        `${canonical} is absent from the sparse index`,
      );
    const metadataDigest = await canonicalDigest(
      metadata as unknown as JsonValue,
    );
    const translated = await this.codec.translateMetadata(metadata, {
      providerId: this.providerId,
      endpoint: record.endpoint,
      retrievedAt: record.retrievedAt,
      evaluationTime: record.retrievedAt,
      ...(record.etag === undefined ? {} : { etag: record.etag }),
      metadataDigest,
      rawMetadataRef: {
        type: 'provider-metadata',
        locator: `urn:openpacker:cargo:${metadata.name}:${metadata.vers}`,
        digest: metadataDigest,
        mediaType: 'application/json',
      },
    });
    if (translated.instance.artifacts[0]) {
      translated.instance.artifacts[0].locations = [
        {
          transport: 'https',
          uri: `${this.downloadEndpoint}/${metadata.name}/${metadata.name}-${metadata.vers}.crate`,
          priority: 0,
          rangeSupported: true,
        },
      ];
    }
    return { package: translated.instance, record, warnings: [] };
  }

  async fetchArtifactRecord(
    exactPurl: string,
    signal?: AbortSignal,
  ): Promise<ProviderRecord> {
    const inspection = await this.inspect(exactPurl, signal);
    const parsed = parsePurl(this.codec.canonicalizePurl(exactPurl));
    if (!parsed.version)
      throw new ProviderError(
        'ARTIFACT_NOT_FOUND',
        `No exact crate coordinate for ${exactPurl}`,
      );
    const url = `${this.downloadEndpoint}/${parsed.name}/${parsed.name}-${parsed.version}.crate`;
    const response = await this.transport.request({
      url,
      signal,
      maximumBytes: 128 * 1024 * 1024,
      headers: { accept: 'application/octet-stream' },
    });
    if (response.status < 200 || response.status >= 300)
      throw providerErrorForStatus(response.status);
    const nativeData = inspection.package.nativeSemantics.data as Record<
      string,
      JsonValue
    >;
    const checksum = nativeData.checksum;
    if (
      typeof checksum !== 'string' ||
      !(await verifyNativeDigest(response.body, 'sha256', checksum))
    )
      throw new ProviderError(
        'DIGEST_MISMATCH',
        'Cargo crate checksum mismatch',
      );
    const expectedSize = inspection.package.artifacts[0]?.size;
    if (expectedSize !== undefined && expectedSize !== response.body.byteLength)
      throw new ProviderError(
        'SIZE_MISMATCH',
        `Cargo crate size ${response.body.byteLength} does not match ${expectedSize}`,
      );
    const digest = await sha256(response.body);
    const artifact: ArtifactDescriptor = {
      descriptorId: `${inspection.package.nodeId}:crate`,
      digest,
      size: response.body.byteLength,
      mediaType: 'application/gzip',
      artifactType: 'application/vnd.openpacker.cargo.crate.v1+tar',
      fileName: `${parsed.name}-${parsed.version}.crate`,
      nativeRole: 'package-archive',
      locations: [
        {
          transport: 'https',
          uri: url,
          priority: 0,
          rangeSupported: true,
        },
      ],
      referrers: [],
      externalRefs: [],
    };
    return {
      key: exactPurl,
      endpoint: response.url,
      body: artifact,
      rawBody: response.body,
      retrievedAt: inspection.record.retrievedAt,
    };
  }

  async snapshot(
    evaluationTime: string,
    signal?: AbortSignal,
  ): Promise<SourceSnapshot> {
    if (signal?.aborted)
      throw (
        signal.reason ?? new ProviderError('CANCELLED', 'Snapshot cancelled')
      );
    const records = await Promise.all(
      [...this.#records.values()]
        .sort((a, b) => compareCodePoints(a.key, b.key))
        .map(async (record) => ({
          key: record.key,
          ...(record.etag === undefined ? {} : { etag: record.etag }),
          digest: formatDigest(await sha256(record.rawBody)),
        })),
    );
    const recordsDigest = await canonicalDigest(records as JsonValue);
    const revision = formatDigest(recordsDigest);
    const etags = [
      ...new Set(
        [...this.#records.values()]
          .map((record) => record.etag)
          .filter((etag): etag is string => etag !== undefined),
      ),
    ];
    const etag = etags.length === 1 ? etags[0] : undefined;
    const retrievedAt =
      [...this.#records.values()]
        .map((record) => record.retrievedAt)
        .sort()
        .at(-1) ?? evaluationTime;
    const rootDigest = await canonicalDigest({
      providerId: this.providerId,
      providerType: 'cargo-sparse',
      endpointIdentity: this.endpoint,
      retrievedAt,
      evaluationTime,
      revision,
      ...(etag === undefined ? {} : { etag }),
      records,
    } as JsonValue);
    return {
      snapshotId: formatDigest(rootDigest),
      providerId: this.providerId,
      providerType: 'cargo-sparse',
      endpointIdentity: this.endpoint,
      retrievedAt,
      evaluationTime,
      revision,
      ...(etag === undefined ? {} : { etag }),
      rootDigest,
      recordsDigest,
      evidenceRefs: [],
    };
  }

  private purlFor(coordinate: NativeCoordinate): string {
    return this.codec.canonicalizePurl(
      formatPurl({
        type: 'cargo',
        name: coordinate.name,
        version: coordinate.version,
        qualifiers: {},
      }),
    );
  }

  private async indexRecord(
    purl: string,
    signal?: AbortSignal,
  ): Promise<ProviderRecord<readonly CargoIndexRecord[]>> {
    const parsed = parsePurl(this.codec.canonicalizePurl(purl));
    const key = formatPurl({ ...parsed, version: undefined });
    const existing = this.#records.get(key);
    const url = `${this.endpoint.replace(/\/$/, '')}/${sparseIndexPath(parsed.name)}`;
    const response = await this.transport.request({
      url,
      signal,
      maximumBytes: 8 * 1024 * 1024,
      headers: {
        accept: 'text/plain',
        ...(existing?.etag === undefined
          ? {}
          : { 'if-none-match': existing.etag }),
      },
    });
    if (response.status === 304) {
      if (!existing)
        throw new ProviderError(
          'STALE_METADATA',
          `Received 304 without cached metadata for ${key}`,
          304,
        );
      const revalidated = { ...existing, retrievedAt: this.clock.now() };
      this.#records.set(key, revalidated);
      return revalidated;
    }
    if (response.status < 200 || response.status >= 300)
      throw new ProviderError(
        'UPSTREAM_UNAVAILABLE',
        `Cargo sparse index returned ${response.status}`,
        response.status,
      );
    let body: CargoIndexRecord[];
    try {
      const lines = text(response).split(/\r?\n/).filter(Boolean);
      if (lines.length > 100_000)
        throw new ProviderError(
          'UPSTREAM_RESPONSE_TOO_LARGE',
          'Cargo sparse index exceeds 100000 records',
        );
      body = lines.map((line, index) => {
        try {
          const parsed = JSON.parse(line) as CargoIndexRecord;
          assertBoundedProviderMetadata(parsed);
          return parsed;
        } catch {
          throw new ProviderError(
            'INVALID_PROVIDER_METADATA',
            `Invalid Cargo sparse index JSON at line ${index + 1}`,
          );
        }
      });
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(
        'INVALID_PROVIDER_METADATA',
        error instanceof Error ? error.message : 'Invalid Cargo sparse index',
      );
    }
    const record: ProviderRecord<readonly CargoIndexRecord[]> = {
      key,
      endpoint: response.url,
      ...(header(response, 'etag') === undefined
        ? {}
        : { etag: header(response, 'etag') }),
      body,
      rawBody: response.body,
      retrievedAt: this.clock.now(),
    };
    this.#records.set(record.key, record);
    return record;
  }
}
