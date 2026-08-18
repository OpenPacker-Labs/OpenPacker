import { canonicalDigest, formatDigest, sha256 } from '@openpacker/canonical';
import type {
  ArtifactDescriptor,
  Digest,
  PackageIdentity,
  PackageInstance,
  Requirement,
  SemanticLoss,
  SourceSnapshot,
  TargetPredicate,
  VersionConstraint,
  JsonValue,
} from '@openpacker/contracts';
import {
  compareParsedVersions,
  compareCodePoints,
  evaluateRange,
  evaluateSemverRange,
  formatPurl,
  header,
  json,
  packageNodeId,
  parsePurl,
  parseSemver,
  parseSemverRange,
  ProviderError,
  providerErrorForStatus,
  rangeToConstraint,
  semanticLoss,
  sourceRef,
  verifyNativeDigest,
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

export interface NpmVersionMetadata {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  devDependencies?: Record<string, string>;
  engines?: Record<string, string>;
  os?: string[];
  cpu?: string[];
  deprecated?: string;
  dist?: {
    tarball?: string;
    integrity?: string;
    shasum?: string;
    size?: number;
    fileCount?: number;
    unpackedSize?: number;
  };
  scripts?: Record<string, string>;
  [key: string]: unknown;
}

export interface NpmPackument {
  name: string;
  versions: Record<string, NpmVersionMetadata>;
  'dist-tags'?: Record<string, string>;
  time?: Record<string, string>;
  etag?: string;
  [key: string]: unknown;
}

export interface NpmPackageLockV3 {
  name?: string;
  version?: string;
  lockfileVersion: 3;
  packages: Record<
    string,
    {
      name?: string;
      version?: string;
      resolved?: string;
      integrity?: string;
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
      dev?: boolean;
      optional?: boolean;
      link?: boolean;
      [key: string]: unknown;
    }
  >;
}

const npmName = (namespace: string | undefined, name: string): string =>
  namespace === undefined ? name : `@${namespace.replace(/^@/, '')}/${name}`;
const npmNamespace = (namespace: string | undefined): string | undefined =>
  namespace === undefined
    ? undefined
    : `@${namespace.replace(/^@/, '').toLowerCase()}`;

function identityFromPurl(value: string): PackageIdentity {
  const parsed = parsePurl(value);
  const base = formatPurl({ ...parsed, version: undefined });
  const identity: PackageIdentity = {
    canonicalPurl: base,
    purlType: 'npm',
    name: parsed.name,
    qualifiers: { ...parsed.qualifiers },
    nativeCoordinates: [
      {
        ecosystem: 'npm',
        coordinate: npmName(parsed.namespace, parsed.name),
        ...(parsed.version === undefined ? {} : { version: parsed.version }),
      },
    ],
    aliases: [],
    sourceRefs: [],
    publisherRefs: [],
    externalRefs: [],
  };
  if (parsed.namespace !== undefined) identity.namespace = parsed.namespace;
  if (parsed.version !== undefined) {
    identity.version = parsed.version;
    identity.exactPurl = formatPurl(parsed);
  }
  if (parsed.subpath !== undefined) identity.subpath = parsed.subpath;
  return identity;
}

function sriSha256(value: string | undefined): Digest | undefined {
  const token = value
    ?.split(/\s+/)
    .find((entry) => entry.startsWith('sha256-'));
  if (!token) return undefined;
  try {
    const bytes = Uint8Array.from(atob(token.slice(7)), (character) =>
      character.charCodeAt(0),
    );
    if (bytes.byteLength !== 32) return undefined;
    return {
      algorithm: 'sha256',
      value: [...bytes]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join(''),
    };
  } catch {
    return undefined;
  }
}

function npmRequirement(
  dependerNodeId: string,
  name: string,
  range: string,
  kind: Requirement['kind'],
  optional: boolean,
  endpoint: string,
  path: string,
): Requirement {
  const coordinate = new NpmCodec().parseNativeCoordinate(name);
  const parsed = new NpmCodec().parseNativeRange(range);
  return {
    id: `${dependerNodeId}:${kind}:${name}`,
    dependerNodeId,
    expression: {
      type: 'package',
      purl: formatPurl({
        type: 'npm',
        namespace: npmNamespace(coordinate.namespace),
        name: coordinate.name,
        qualifiers: {},
      }),
      ...(parsed.vers === undefined ? {} : { vers: parsed.vers }),
    },
    kind,
    optional,
    source: sourceRef('npm', endpoint),
    authority: 'native',
    raw: { path, range },
    nativeSemantics: {
      version: 'npm-v1',
      data: { dependencyField: path.slice(1).split('/')[0]!, range },
    },
    semanticLoss: [...parsed.semanticLoss],
  };
}

function npmTargetPredicate(
  os: readonly string[] | undefined,
  cpu: readonly string[] | undefined,
): TargetPredicate | undefined {
  const predicates: TargetPredicate[] = [];
  for (const [path, values] of [
    ['os', os],
    ['architecture', cpu],
  ] as const) {
    const included = (values ?? []).filter(
      (value) => value !== '*' && !value.startsWith('!'),
    );
    const excluded = (values ?? [])
      .filter((value) => value.startsWith('!'))
      .map((value) => value.slice(1));
    if (included.length > 0)
      predicates.push({ type: 'in', path, values: included });
    if (excluded.length > 0)
      predicates.push({ type: 'notIn', path, values: excluded });
  }
  return predicates.length === 0
    ? undefined
    : predicates.length === 1
      ? predicates[0]
      : { type: 'allOf', predicates };
}

export class NpmCodec
  implements EcosystemCodec<NpmVersionMetadata, NpmPackageLockV3>
{
  readonly purlType = 'npm' as const;

  parseNativeCoordinate(value: string): NativeCoordinate {
    const match = /^(?:@([^/\s]+)\/)?([^@/\s]+)(?:@(.+))?$/.exec(value.trim());
    if (!match)
      throw new ProviderError(
        'INVALID_NATIVE_COORDINATE',
        `Invalid npm coordinate: ${value}`,
      );
    const result: NativeCoordinate = {
      ecosystem: 'npm',
      name: match[2]!.toLowerCase(),
      original: value,
    };
    if (match[1] !== undefined) result.namespace = match[1].toLowerCase();
    if (match[3] !== undefined) result.version = match[3];
    return result;
  }

  canonicalizePurl(value: string): string {
    const parsed = parsePurl(value);
    if (parsed.type !== 'npm')
      throw new ProviderError(
        'INVALID_PURL',
        `Expected npm PURL, received ${parsed.type}`,
      );
    return formatPurl({
      ...parsed,
      namespace: npmNamespace(parsed.namespace),
      name: parsed.name.toLowerCase(),
      version:
        parsed.version === undefined
          ? undefined
          : this.parseNativeVersion(parsed.version).normalized,
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
      scheme: 'npm',
      bare: 'exact',
      hyphenRanges: true,
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
    metadata: NpmVersionMetadata,
    provenance: TranslationProvenance,
  ): Promise<TranslatedMetadata> {
    const coordinate = this.parseNativeCoordinate(metadata.name);
    const exactPurl = this.canonicalizePurl(
      formatPurl({
        type: 'npm',
        namespace: npmNamespace(coordinate.namespace),
        name: coordinate.name,
        version: metadata.version,
        qualifiers: {},
      }),
    );
    const nodeId = await packageNodeId({
      exactPurl,
      nativeSemanticsVersion: 'npm-v1',
    });
    const requirements: Requirement[] = [];
    const optionalNames = new Set(
      Object.keys(metadata.optionalDependencies ?? {}),
    );
    const fields: readonly [
      Record<string, string> | undefined,
      Requirement['kind'],
      boolean,
      string,
    ][] = [
      [
        Object.fromEntries(
          Object.entries(metadata.dependencies ?? {}).filter(
            ([name]) => !optionalNames.has(name),
          ),
        ),
        'runtime',
        false,
        'dependencies',
      ],
      [metadata.optionalDependencies, 'optional', true, 'optionalDependencies'],
      [metadata.peerDependencies, 'peer', false, 'peerDependencies'],
      [metadata.devDependencies, 'development', true, 'devDependencies'],
    ];
    for (const [dependencies, kind, optionalByKind, field] of fields) {
      for (const [name, range] of Object.entries(dependencies ?? {}).sort(
        ([left], [right]) => compareCodePoints(left, right),
      )) {
        const optional =
          optionalByKind ||
          (field === 'peerDependencies' &&
            metadata.peerDependenciesMeta?.[name]?.optional === true);
        requirements.push(
          npmRequirement(
            nodeId,
            name,
            range,
            kind,
            optional,
            provenance.endpoint,
            `/${field}/${name}`,
          ),
        );
      }
    }
    const losses: SemanticLoss[] = [];
    if (metadata.scripts && Object.keys(metadata.scripts).length > 0) {
      losses.push(
        semanticLoss(
          'npm',
          'NPM_LIFECYCLE_SCRIPTS_NOT_EXECUTED',
          '/scripts',
          'Lifecycle scripts are preserved as inert metadata and never executed',
        ),
      );
    }
    const targetPredicate = npmTargetPredicate(metadata.os, metadata.cpu);
    if (metadata.os || metadata.cpu) {
      losses.push(
        semanticLoss(
          'npm',
          'NPM_PACKAGE_TARGET_PREDICATE_ARTIFACT_ONLY',
          '/os',
          'npm os and cpu constraints apply to the package as a whole',
          'The exact predicate is preserved and applied to artifacts, but PackageInstance has no package-level predicate',
          'error',
        ),
      );
    }
    if (metadata.engines)
      losses.push(
        semanticLoss(
          'npm',
          'NPM_ENGINE_RANGE_NATIVE_ONLY',
          '/engines',
          'npm engine compatibility uses npm range and advisory enforcement semantics',
          undefined,
          'error',
        ),
      );
    const artifacts: ArtifactDescriptor[] = [];
    const digest = sriSha256(metadata.dist?.integrity);
    if (metadata.dist?.tarball && digest && metadata.dist.size !== undefined) {
      artifacts.push({
        descriptorId: `${nodeId}:tarball`,
        digest,
        size: metadata.dist.size,
        mediaType: 'application/gzip',
        artifactType: 'application/vnd.openpacker.npm.package.v1+tgz',
        ...(metadata.dist.tarball.split('/').at(-1) === undefined
          ? {}
          : { fileName: metadata.dist.tarball.split('/').at(-1)! }),
        nativeRole: 'package-archive',
        ...(targetPredicate === undefined ? {} : { targetPredicate }),
        locations: [
          {
            transport: 'https',
            uri: metadata.dist.tarball,
            priority: 0,
            rangeSupported: true,
          },
        ],
        referrers: [],
        externalRefs: [],
      });
    } else if (metadata.dist?.tarball) {
      losses.push(
        semanticLoss(
          'npm',
          'NPM_SHA256_NOT_SUPPLIED',
          '/dist/integrity',
          'Upstream integrity did not contain SHA-256; native integrity remains in raw metadata',
        ),
      );
    }
    const identity = identityFromPurl(exactPurl);
    identity.sourceRefs = [sourceRef('npm', provenance.endpoint)];
    const instance: PackageInstance = {
      nodeId,
      identity,
      nativeVersion: metadata.version,
      normalizedVersion: this.parseNativeVersion(metadata.version).normalized,
      versionSortKey: this.parseNativeVersion(metadata.version).normalized,
      requirements,
      capabilities: [],
      conflicts: [],
      cardinalityConstraints: [],
      artifacts,
      lifecycle: {
        status: metadata.deprecated === undefined ? 'published' : 'deprecated',
        eligible: true,
        warnings:
          metadata.deprecated === undefined
            ? []
            : [{ code: 'NPM_DEPRECATED', message: metadata.deprecated }],
      },
      sourceSnapshots:
        provenance.snapshotDigest === undefined
          ? []
          : [provenance.snapshotDigest],
      metadataDigest: provenance.metadataDigest,
      nativeSemantics: {
        version: 'npm-v1',
        data: {
          distTagsAreMutable: true,
          engines: metadata.engines ?? {},
          os: metadata.os ?? [],
          cpu: metadata.cpu ?? [],
          ...(targetPredicate === undefined ? {} : { targetPredicate }),
          peerDependenciesMeta: metadata.peerDependenciesMeta ?? {},
          scripts: metadata.scripts ?? {},
          ...(metadata.dist?.integrity === undefined
            ? {}
            : { distIntegrity: metadata.dist.integrity }),
          ...(metadata.dist?.shasum === undefined
            ? {}
            : { distShasum: metadata.dist.shasum }),
        } as JsonValue,
      },
      semanticLoss: losses,
    };
    if (provenance.rawMetadataRef !== undefined)
      instance.rawMetadataRef = provenance.rawMetadataRef;
    return { instance, rawMetadata: metadata };
  }

  translateLockResult(
    lock: NpmPackageLockV3,
    provenance: TranslationProvenance,
  ): LockCapture {
    if (lock.lockfileVersion !== 3)
      throw new ProviderError(
        'INVALID_LOCKFILE',
        `Expected package-lock v3, received ${String(lock.lockfileVersion)}`,
      );
    const packages = Object.entries(lock.packages)
      .filter(([, entry]) => entry.link !== true && entry.version !== undefined)
      .map(([path, entry]) => {
        const inferred = entry.name ?? path.split('node_modules/').at(-1);
        if (!inferred || !entry.version)
          throw new ProviderError(
            'INVALID_LOCKFILE',
            `Cannot infer package identity at ${path}`,
          );
        const coordinate = this.parseNativeCoordinate(inferred);
        return {
          exactPurl: this.canonicalizePurl(
            formatPurl({
              type: 'npm',
              namespace: npmNamespace(coordinate.namespace),
              name: coordinate.name,
              version: entry.version,
              qualifiers: {},
            }),
          ),
          nativeCoordinate: `${inferred}@${entry.version}`,
          ...(entry.resolved === undefined ? {} : { resolved: entry.resolved }),
          ...(entry.integrity === undefined
            ? {}
            : { artifactDigest: entry.integrity }),
          dependencies: {
            ...(entry.dependencies ?? {}),
            ...(entry.optionalDependencies ?? {}),
          },
          native: {
            path,
            dev: entry.dev ?? false,
            optional: entry.optional ?? false,
            ...(entry.integrity === undefined
              ? {}
              : { integrity: entry.integrity }),
          },
        };
      })
      .sort((left, right) =>
        compareCodePoints(left.exactPurl, right.exactPurl),
      );
    return {
      format: 'package-lock.json',
      formatVersion: '3',
      packages,
      semanticLoss: [],
      sourceDigest: formatDigest(provenance.metadataDigest),
    };
  }
}

export class NpmRegistryProvider implements CatalogProvider {
  readonly providerId = 'npm-registry';
  readonly capabilities: ProviderCapabilities = {
    operations: ['identify', 'enumerate', 'inspect', 'artifact', 'snapshot'],
    purlTypes: ['npm'],
    qualifierSupport: 'complete',
    targetSpecificSemantics: true,
    offlineReplay: true,
    extensions: { 'openpacker.dev/packument': 'full-metadata' },
  };
  readonly #records = new Map<string, ProviderRecord<NpmPackument>>();

  constructor(
    private readonly transport: HttpTransport,
    private readonly clock: Clock,
    private readonly endpoint = 'https://registry.npmjs.org',
    private readonly codec = new NpmCodec(),
  ) {}

  async identify(query: string): Promise<readonly PackageIdentity[]> {
    const coordinate = query.startsWith('pkg:')
      ? identityFromPurl(this.codec.canonicalizePurl(query))
      : identityFromPurl(this.purlFor(this.codec.parseNativeCoordinate(query)));
    coordinate.sourceRefs = [sourceRef('npm', this.endpoint)];
    return [coordinate];
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
    const packument = await this.packument(basePurl, signal);
    return Object.keys(packument.body.versions)
      .sort((left, right) => this.codec.compareNativeVersions(left, right))
      .map((version) =>
        this.codec.canonicalizePurl(
          `${this.codec.canonicalizePurl(basePurl)}@${version}`,
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
        'inspect requires an exact npm PURL',
      );
    const record = await this.packument(
      formatPurl({ ...parsed, version: undefined }),
      signal,
    );
    const metadata = record.body.versions[parsed.version];
    if (!metadata)
      throw new ProviderError(
        'VERSION_NOT_FOUND',
        `${canonical} is absent from the packument`,
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
        locator: `urn:openpacker:npm:${encodeURIComponent(metadata.name)}:${metadata.version}`,
        digest: metadataDigest,
        mediaType: 'application/json',
      },
    });
    return { package: translated.instance, record, warnings: [] };
  }

  async fetchArtifactRecord(
    exactPurl: string,
    signal?: AbortSignal,
  ): Promise<ProviderRecord> {
    const inspection = await this.inspect(exactPurl, signal);
    const metadata = inspection.record.body as NpmPackument;
    const version = parsePurl(this.codec.canonicalizePurl(exactPurl)).version!;
    const dist = metadata.versions[version]?.dist;
    if (!dist?.tarball)
      throw new ProviderError(
        'ARTIFACT_NOT_FOUND',
        `No dist record for ${exactPurl}`,
      );
    const response = await this.transport.request({
      url: dist.tarball,
      signal,
      maximumBytes: 128 * 1024 * 1024,
      headers: { accept: 'application/octet-stream' },
    });
    if (response.status < 200 || response.status >= 300)
      throw providerErrorForStatus(response.status);
    if (dist.size !== undefined && response.body.byteLength !== dist.size)
      throw new ProviderError(
        'SIZE_MISMATCH',
        `npm tarball size ${response.body.byteLength} does not match ${dist.size}`,
      );
    if (dist.integrity !== undefined) {
      const supported = dist.integrity
        .split(/\s+/)
        .map((token) => /^(sha(?:1|256|384|512))-(.+)$/.exec(token))
        .find((match): match is RegExpExecArray => match !== null);
      if (
        supported !== undefined &&
        !(await verifyNativeDigest(response.body, supported[1]!, supported[2]!))
      )
        throw new ProviderError('DIGEST_MISMATCH', 'npm tarball SRI mismatch');
    } else if (
      dist.shasum !== undefined &&
      !(await verifyNativeDigest(response.body, 'sha1', dist.shasum))
    ) {
      throw new ProviderError('DIGEST_MISMATCH', 'npm tarball shasum mismatch');
    }
    const digest = await sha256(response.body);
    const descriptor: ArtifactDescriptor = {
      descriptorId: `${inspection.package.nodeId}:tarball`,
      digest,
      size: response.body.byteLength,
      mediaType: 'application/gzip',
      artifactType: 'application/vnd.openpacker.npm.package.v1+tgz',
      ...(dist.tarball.split('/').at(-1) === undefined
        ? {}
        : { fileName: dist.tarball.split('/').at(-1)! }),
      nativeRole: 'package-archive',
      locations: [
        {
          transport: 'https',
          uri: dist.tarball,
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
      body: descriptor,
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
    const recordDigests = await Promise.all(
      [...this.#records.values()]
        .sort((a, b) => compareCodePoints(a.key, b.key))
        .map(async (record) => ({
          key: record.key,
          ...(record.etag === undefined ? {} : { etag: record.etag }),
          digest: formatDigest(await sha256(record.rawBody)),
        })),
    );
    const recordsDigest = await canonicalDigest(recordDigests as JsonValue);
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
    const rootPayload = {
      providerId: this.providerId,
      providerType: 'npm-registry',
      endpointIdentity: this.endpoint,
      retrievedAt,
      evaluationTime,
      revision,
      ...(etag === undefined ? {} : { etag }),
      records: recordDigests,
    };
    const rootDigest = await canonicalDigest(rootPayload as JsonValue);
    return {
      snapshotId: formatDigest(rootDigest),
      providerId: this.providerId,
      providerType: 'npm-registry',
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
        type: 'npm',
        namespace: npmNamespace(coordinate.namespace),
        name: coordinate.name,
        version: coordinate.version,
        qualifiers: {},
      }),
    );
  }

  private async packument(
    purl: string,
    signal?: AbortSignal,
  ): Promise<ProviderRecord<NpmPackument>> {
    const canonical = this.codec.canonicalizePurl(purl);
    const parsed = parsePurl(canonical);
    const key = formatPurl({ ...parsed, version: undefined });
    const existing = this.#records.get(key);
    const name = npmName(parsed.namespace, parsed.name);
    const url = `${this.endpoint.replace(/\/$/, '')}/${encodeURIComponent(name)}`;
    const response = await this.transport.request({
      url,
      signal,
      maximumBytes: 8 * 1024 * 1024,
      headers: {
        accept: 'application/vnd.npm.install-v1+json',
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
    const record: ProviderRecord<NpmPackument> = {
      key,
      endpoint: response.url,
      ...(header(response, 'etag') === undefined
        ? {}
        : { etag: header(response, 'etag') }),
      body: json<NpmPackument>(response),
      rawBody: response.body,
      retrievedAt: this.clock.now(),
    };
    this.#records.set(record.key, record);
    return record;
  }
}

export { NpmProjectFormat, npmPublishPaths } from './project.js';
