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
  assertPackageIdentityMatchesRequest,
  evaluateRange,
  compareCodePoints,
  encodeUrlPathComponent,
  formatPurl,
  header,
  json,
  packageNodeId,
  parsePurl,
  ProviderError,
  providerErrorForStatus,
  rangeToConstraint,
  renderRange,
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
  type RangeAst,
  type TranslatedMetadata,
  type TranslationProvenance,
} from '@openpacker/adapter-core';

export interface NugetDependency {
  id: string;
  range: string;
}

export interface NugetDependencyGroup {
  targetFramework?: string;
  dependencies?: NugetDependency[];
}

export interface NugetCatalogEntry {
  id: string;
  version: string;
  listed?: boolean;
  published?: string;
  dependencyGroups?: NugetDependencyGroup[];
  packageTypes?: { name: string; version?: string }[];
  deprecation?: unknown;
  vulnerabilities?: unknown[];
  repository?: { type?: string; url?: string; commit?: string };
  packageHash?: string;
  packageHashAlgorithm?: string;
  packageSize?: number;
  openpackerSha256?: string;
  [key: string]: unknown;
}

export interface NugetRegistrationLeaf {
  catalogEntry: NugetCatalogEntry;
  packageContent?: string;
}

export interface NugetRegistrationPage {
  '@id'?: string;
  count?: number;
  lower?: string;
  upper?: string;
  items?: NugetRegistrationLeaf[];
}

export interface NugetRegistrationIndex {
  items: (NugetRegistrationPage | NugetRegistrationLeaf)[];
}

export interface NugetPackagesLock {
  version: number;
  dependencies: Record<
    string,
    Record<
      string,
      {
        type?: string;
        requested?: string;
        resolved: string;
        contentHash?: string;
        dependencies?: Record<string, string>;
      }
    >
  >;
}

export interface NugetProjectAssets {
  version: number;
  targets: Record<
    string,
    Record<string, { type?: string; dependencies?: Record<string, string> }>
  >;
  libraries?: Record<string, { sha512?: string; path?: string; type?: string }>;
}

export type NugetLockInput =
  | { format: 'packages.lock.json'; data: NugetPackagesLock }
  | { format: 'project.assets.json'; data: NugetProjectAssets };

export function parseNugetVersion(value: string): ParsedVersion {
  const match =
    /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z.-]+))?$/.exec(
      value.trim(),
    );
  if (!match)
    throw new ProviderError(
      'INVALID_NATIVE_VERSION',
      `Invalid NuGet version: ${value}`,
    );
  const release = [
    Number(match[1]),
    Number(match[2] ?? 0),
    Number(match[3] ?? 0),
    Number(match[4] ?? 0),
  ];
  const renderedRelease = release[3] === 0 ? release.slice(0, 3) : release;
  const prerelease =
    match[5]
      ?.split('.')
      .map((part) =>
        /^\d+$/.test(part) ? Number(part) : part.toLowerCase(),
      ) ?? [];
  const build = match[6]?.split('.') ?? [];
  return {
    original: value,
    normalized: `${renderedRelease.join('.')}${prerelease.length === 0 ? '' : `-${prerelease.join('.')}`}`,
    release,
    prerelease,
    build,
  };
}

function compareNugetParsed(left: ParsedVersion, right: ParsedVersion): number {
  for (let index = 0; index < 4; index += 1) {
    const difference = (left.release[index] ?? 0) - (right.release[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0)
    return left.prerelease.length === right.prerelease.length
      ? 0
      : left.prerelease.length === 0
        ? 1
        : -1;
  for (
    let index = 0;
    index < Math.max(left.prerelease.length, right.prerelease.length);
    index += 1
  ) {
    const a = left.prerelease[index];
    const b = right.prerelease[index];
    if (a === undefined || b === undefined)
      return a === b ? 0 : a === undefined ? -1 : 1;
    if (a === b) continue;
    if (typeof a === 'number' && typeof b === 'number') return Math.sign(a - b);
    if (typeof a === 'number') return -1;
    if (typeof b === 'number') return 1;
    return compareCodePoints(a.toLowerCase(), b.toLowerCase());
  }
  return 0;
}

function nugetVers(ast: RangeAst): string | undefined {
  if (ast.type === 'any') return '*';
  if (ast.type === 'comparison') return `${ast.operator}${ast.version}`;
  if (ast.type === 'or') return undefined;
  const parts = ast.items.map(nugetVers);
  return parts.some((part) => part === undefined) ? undefined : parts.join('|');
}

function nugetIdentity(exactPurl: string, endpoint?: string): PackageIdentity {
  const parsed = parsePurl(exactPurl);
  const identity: PackageIdentity = {
    canonicalPurl: formatPurl({ ...parsed, version: undefined }),
    purlType: 'nuget',
    name: parsed.name,
    qualifiers: { ...parsed.qualifiers },
    nativeCoordinates: [
      {
        ecosystem: 'nuget',
        coordinate: parsed.name,
        ...(!(parsed.version === undefined) && { version: parsed.version }),
      },
    ],
    aliases: [],
    sourceRefs: endpoint === undefined ? [] : [sourceRef('nuget', endpoint)],
    publisherRefs: [],
    externalRefs: [],
  };
  if (parsed.version !== undefined) {
    identity.version = parsed.version;
    identity.exactPurl = formatPurl(parsed);
  }
  return identity;
}

function nugetFloatingPrereleaseMatches(
  version: ParsedVersion,
  originalRange: string,
): boolean {
  const range = originalRange.trim();
  if (!/[*xX]/.test(range) || version.prerelease.length === 0) return true;
  const [releasePattern, prereleasePattern] = range.split('-', 2);
  if (prereleasePattern === undefined) return false;
  const releaseParts = releasePattern!
    .split('.')
    .filter((part) => !/[*xX]/.test(part))
    .map(Number);
  if (
    releaseParts.some(
      (part, index) =>
        !Number.isFinite(part) || version.release[index] !== part,
    )
  )
    return false;
  if (/^(?:\*|x)$/i.test(prereleasePattern)) return true;
  const prefix = prereleasePattern.replace(/\.(?:\*|x)$/i, '').split('.');
  return prefix.every(
    (part, index) =>
      String(version.prerelease[index]).toLowerCase() === part.toLowerCase(),
  );
}

export class NugetCodec
  implements EcosystemCodec<NugetCatalogEntry, NugetLockInput>
{
  readonly purlType = 'nuget' as const;

  parseNativeCoordinate(value: string): NativeCoordinate {
    const match = /^([^@/\s]+)(?:@(.+))?$/.exec(value.trim());
    if (!match)
      throw new ProviderError(
        'INVALID_NATIVE_COORDINATE',
        `Invalid NuGet coordinate: ${value}`,
      );
    return {
      ecosystem: 'nuget',
      name: match[1]!.toLowerCase(),
      original: value,
      ...(!(match[2] === undefined) && { version: match[2] }),
    };
  }

  canonicalizePurl(value: string): string {
    const parsed = parsePurl(value);
    if (parsed.type !== 'nuget' || parsed.namespace !== undefined)
      throw new ProviderError(
        'INVALID_PURL',
        'NuGet PURLs do not have namespaces',
      );
    const name = nugetPathComponent(parsed.name, 'package ID');
    return formatPurl({
      ...parsed,
      name,
      ...(!(parsed.version === undefined) && {
        version: this.parseNativeVersion(parsed.version).normalized,
      }),
    });
  }

  parseNativeVersion(value: string): ParsedVersion {
    return parseNugetVersion(value);
  }

  compareNativeVersions(left: string, right: string): number {
    return compareNugetParsed(
      this.parseNativeVersion(left),
      this.parseNativeVersion(right),
    );
  }

  parseNativeRange(value: string): ParsedRange {
    if (value.length > 4096)
      throw new ProviderError(
        'INVALID_NATIVE_RANGE',
        'Native range exceeds 4096 characters',
      );
    const original = value;
    const trimmed = value.trim();
    let ast: RangeAst;
    let floating = false;
    if (trimmed === '') {
      ast = { type: 'any' };
    } else if (/^[[(].*,.*[\])]$/.test(trimmed)) {
      const lowerInclusive = trimmed.startsWith('[');
      const upperInclusive = trimmed.endsWith(']');
      const [lower, upper] = trimmed
        .slice(1, -1)
        .split(',', 2)
        .map((part) => part!.trim());
      const items: RangeAst[] = [];
      if (lower)
        items.push({
          type: 'comparison',
          operator: lowerInclusive ? '>=' : '>',
          version: this.parseNativeVersion(lower).normalized,
        });
      if (upper)
        items.push({
          type: 'comparison',
          operator: upperInclusive ? '<=' : '<',
          version: this.parseNativeVersion(upper).normalized,
        });
      ast =
        items.length === 0
          ? { type: 'any' }
          : items.length === 1
            ? items[0]!
            : { type: 'and', items };
    } else if (/^\[.*\]$/.test(trimmed)) {
      ast = {
        type: 'comparison',
        operator: '=',
        version: this.parseNativeVersion(trimmed.slice(1, -1)).normalized,
      };
    } else if (/[*xX]/.test(trimmed)) {
      floating = true;
      const [releasePattern, prereleasePattern] = trimmed.split('-', 2);
      const parts = releasePattern!.split('.');
      const wildcard = parts.findIndex((part) => /[*xX]/.test(part));
      const fixedParts = wildcard < 0 ? parts : parts.slice(0, wildcard);
      const release = fixedParts.map((part) => Number(part));
      if (release.some(Number.isNaN))
        throw new ProviderError(
          'INVALID_NATIVE_RANGE',
          `Invalid NuGet floating range: ${value}`,
        );
      if (release.length === 0) ast = { type: 'any' };
      else {
        if (release.length > 4)
          throw new ProviderError(
            'INVALID_NATIVE_RANGE',
            `Invalid NuGet floating range: ${value}`,
          );
        const specifiedParts = release.length;
        while (release.length < 4) release.push(0);
        const incrementAt = Math.min(specifiedParts - 1, 3);
        const upper = release.map((part, index) =>
          index < incrementAt ? part : index === incrementAt ? part + 1 : 0,
        );
        const lowerVersion = this.parseNativeVersion(
          `${release.join('.')}${
            prereleasePattern === undefined
              ? ''
              : prereleasePattern === '*'
                ? '-0'
                : `-${prereleasePattern.replace(/\.(?:\*|x)$/i, '')}`
          }`,
        ).normalized;
        ast = {
          type: 'and',
          items: [
            { type: 'comparison', operator: '>=', version: lowerVersion },
            {
              type: 'comparison',
              operator: '<',
              version: this.parseNativeVersion(upper.join('.')).normalized,
            },
          ],
        };
      }
    } else {
      ast = {
        type: 'comparison',
        operator: '>=',
        version: this.parseNativeVersion(trimmed).normalized,
      };
    }
    const body = floating ? undefined : nugetVers(ast);
    return {
      scheme: 'nuget',
      original,
      normalized: renderRange(ast),
      ast,
      ...(!(body === undefined) && { vers: `vers:nuget/${body}` }),
      reversible: body !== undefined,
      semanticLoss:
        body === undefined
          ? [
              semanticLoss(
                'nuget',
                floating
                  ? 'NUGET_FLOATING_RANGE_NOT_EXACTLY_REPRESENTABLE'
                  : 'NUGET_RANGE_NOT_REVERSIBLE',
                '/range',
                'NuGet range is retained only in its native AST',
              ),
            ]
          : [],
    };
  }

  toVers(value: string): VersionConstraint {
    return rangeToConstraint(this.parseNativeRange(value));
  }

  satisfies(version: string, range: string | ParsedRange): boolean {
    const parsedRange =
      typeof range === 'string' ? this.parseNativeRange(range) : range;
    if (
      !evaluateRange(version, parsedRange.ast, (left, right) =>
        this.compareNativeVersions(left, right),
      )
    )
      return false;
    return nugetFloatingPrereleaseMatches(
      this.parseNativeVersion(version),
      parsedRange.original,
    );
  }

  async translateMetadata(
    metadata: NugetCatalogEntry,
    provenance: TranslationProvenance,
  ): Promise<TranslatedMetadata> {
    const exactPurl = this.canonicalizePurl(
      `pkg:nuget/${encodeURIComponent(metadata.id)}@${encodeURIComponent(metadata.version)}`,
    );
    const nodeId = await packageNodeId({
      exactPurl,
      nativeSemanticsVersion: 'nuget-v1',
    });
    const requirements: Requirement[] = [];
    const losses: SemanticLoss[] = [];
    for (const [groupIndex, group] of (
      metadata.dependencyGroups ?? []
    ).entries()) {
      for (const [dependencyIndex, dependency] of (
        group.dependencies ?? []
      ).entries()) {
        const range = this.parseNativeRange(dependency.range);
        const targetLoss =
          group.targetFramework === undefined
            ? []
            : [
                semanticLoss(
                  'nuget',
                  'NUGET_TFM_COMPATIBILITY_NATIVE_ONLY',
                  `/dependencyGroups/${groupIndex}/targetFramework`,
                  'NuGet selects dependency groups using framework compatibility and nearest-framework rules',
                  'The exact target framework is retained; equality is only a conservative PREX predicate',
                  'error',
                ),
              ];
        const packageExpression: Requirement['expression'] = {
          type: 'package',
          purl: `pkg:nuget/${encodeURIComponent(dependency.id.toLowerCase())}`,
          ...(!(range.vers === undefined) && { vers: range.vers }),
        };
        requirements.push({
          id: `${nodeId}:runtime:${groupIndex}:${dependencyIndex}:${dependency.id.toLowerCase()}`,
          dependerNodeId: nodeId,
          expression:
            group.targetFramework === undefined
              ? packageExpression
              : {
                  type: 'conditional',
                  when: {
                    type: 'equals',
                    path: 'variables.tfm',
                    value: group.targetFramework,
                  },
                  then: packageExpression,
                },
          kind: 'runtime',
          optional: false,
          source: sourceRef('nuget', provenance.endpoint),
          authority: 'native',
          // SAFETY: The surrounding boundary establishes the asserted domain contract.
          raw: JSON.parse(JSON.stringify(dependency)) as JsonValue,
          nativeSemantics: {
            version: 'nuget-v1',
            data: { targetFramework: group.targetFramework ?? 'any' },
          },
          semanticLoss: [...range.semanticLoss, ...targetLoss],
        });
      }
    }
    const artifacts: ArtifactDescriptor[] = [];
    if (
      metadata.openpackerSha256 &&
      /^[0-9a-f]{64}$/.test(metadata.openpackerSha256) &&
      metadata.packageSize !== undefined
    ) {
      artifacts.push({
        descriptorId: `${nodeId}:nupkg`,
        digest: { algorithm: 'sha256', value: metadata.openpackerSha256 },
        size: metadata.packageSize,
        mediaType: 'application/zip',
        artifactType: 'application/vnd.openpacker.nuget.nupkg.v1+zip',
        fileName: `${metadata.id}.${this.parseNativeVersion(metadata.version).normalized}.nupkg`,
        nativeRole: 'package-archive',
        locations: [],
        referrers: [],
        externalRefs: [],
      });
    } else {
      losses.push(
        semanticLoss(
          'nuget',
          'NUGET_SHA256_NOT_SUPPLIED',
          '/packageHash',
          'NuGet registration commonly supplies SHA-512; it is preserved in nativeSemantics until archive bytes are acquired',
        ),
      );
    }
    if (metadata.vulnerabilities)
      losses.push(
        semanticLoss(
          'nuget',
          'NUGET_VULNERABILITY_SCHEMA_PROVIDER_SPECIFIC',
          '/vulnerabilities',
          'Provider vulnerability records are preserved and require an enrichment policy to interpret',
        ),
      );
    const listed = metadata.listed !== false;
    const instance: PackageInstance = {
      nodeId,
      identity: nugetIdentity(exactPurl, provenance.endpoint),
      nativeVersion: metadata.version,
      normalizedVersion: this.parseNativeVersion(metadata.version).normalized,
      versionSortKey: this.parseNativeVersion(metadata.version).normalized,
      requirements: requirements.sort((left, right) =>
        compareCodePoints(left.id, right.id),
      ),
      capabilities: [],
      conflicts: [],
      cardinalityConstraints: [],
      artifacts,
      lifecycle: {
        status: listed
          ? metadata.deprecation === undefined
            ? 'published'
            : 'deprecated'
          : 'delisted',
        eligible: listed,
        warnings:
          metadata.deprecation === undefined
            ? []
            : [
                {
                  code: 'NUGET_DEPRECATED',
                  message: 'NuGet registration marks this version deprecated',
                },
              ],
      },
      sourceSnapshots:
        provenance.snapshotDigest === undefined
          ? []
          : [provenance.snapshotDigest],
      metadataDigest: provenance.metadataDigest,
      nativeSemantics: {
        version: 'nuget-v1',
        // SAFETY: The surrounding boundary establishes the asserted domain contract.
        data: JSON.parse(
          JSON.stringify({
            dependencyGroups: metadata.dependencyGroups ?? [],
            packageTypes: metadata.packageTypes ?? [],
            vulnerabilities: metadata.vulnerabilities ?? [],
            ...(!(metadata.deprecation === undefined) && {
              deprecation: metadata.deprecation as JsonValue,
            }),
            ...(!(metadata.repository === undefined) && {
              repository: metadata.repository,
            }),
            ...(!(metadata.packageHash === undefined) && {
              packageHash: metadata.packageHash,
            }),
            ...(!(metadata.packageHashAlgorithm === undefined) && {
              packageHashAlgorithm: metadata.packageHashAlgorithm,
            }),
            listed,
            installScriptsExecuted: false,
          }),
        ),
      },
      semanticLoss: losses,
    };
    if (provenance.rawMetadataRef !== undefined)
      instance.rawMetadataRef = provenance.rawMetadataRef;
    return { instance, rawMetadata: metadata };
  }

  translateLockResult(
    input: NugetLockInput,
    provenance: TranslationProvenance,
  ): LockCapture {
    const packages =
      input.format === 'packages.lock.json'
        ? this.capturePackagesLock(input.data)
        : this.captureAssets(input.data);
    return {
      format: input.format,
      formatVersion: String(input.data.version),
      sourceDigest: formatDigest(provenance.metadataDigest),
      packages,
      semanticLoss: [],
    };
  }

  private capturePackagesLock(
    lock: NugetPackagesLock,
  ): LockCapture['packages'] {
    return Object.entries(lock.dependencies)
      .flatMap(([framework, entries]) =>
        Object.entries(entries).map(([id, entry]) => ({
          exactPurl: this.canonicalizePurl(
            `pkg:nuget/${encodeURIComponent(id)}@${encodeURIComponent(entry.resolved)}`,
          ),
          nativeCoordinate: `${id}@${entry.resolved}`,
          ...(!(entry.contentHash === undefined) && {
            artifactDigest: entry.contentHash,
          }),
          dependencies: { ...(entry.dependencies ?? {}) },
          native: { framework, type: entry.type, requested: entry.requested },
        })),
      )
      .sort((left, right) =>
        compareCodePoints(left.exactPurl, right.exactPurl),
      );
  }

  private captureAssets(assets: NugetProjectAssets): LockCapture['packages'] {
    return Object.entries(assets.targets)
      .flatMap(([target, entries]) =>
        Object.entries(entries).map(([coordinate, entry]) => {
          const split = coordinate.lastIndexOf('/');
          if (split <= 0)
            throw new ProviderError(
              'INVALID_LOCKFILE',
              `Invalid project.assets coordinate: ${coordinate}`,
            );
          const id = coordinate.slice(0, split);
          const version = coordinate.slice(split + 1);
          return {
            exactPurl: this.canonicalizePurl(
              `pkg:nuget/${encodeURIComponent(id)}@${encodeURIComponent(version)}`,
            ),
            nativeCoordinate: `${id}@${version}`,
            ...(!(assets.libraries?.[coordinate]?.sha512 === undefined) && {
              artifactDigest: assets.libraries[coordinate]!.sha512,
            }),
            dependencies: { ...(entry.dependencies ?? {}) },
            native: {
              target,
              type: entry.type,
              library: assets.libraries?.[coordinate],
            },
          };
        }),
      )
      .sort((left, right) =>
        compareCodePoints(left.exactPurl, right.exactPurl),
      );
  }
}

function registrationLeaves(
  index: NugetRegistrationIndex,
): NugetRegistrationLeaf[] {
  return index.items.flatMap((item) =>
    'catalogEntry' in item ? [item] : (item.items ?? []),
  );
}

export interface NugetServiceIndex {
  resources: { '@id': string; '@type': string | string[] }[];
}

const MAX_SERVICE_INDEX_BYTES = 256 * 1024;

export function parseNugetServiceIndex(bytes: Uint8Array): NugetServiceIndex {
  if (bytes.byteLength > MAX_SERVICE_INDEX_BYTES)
    throw new ProviderError(
      'INVALID_PROVIDER_RESPONSE',
      `NuGet service index exceeds ${MAX_SERVICE_INDEX_BYTES} bytes`,
    );
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    throw new ProviderError(
      'INVALID_PROVIDER_RESPONSE',
      `NuGet service index is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  assertServiceIndexComplexity(value);
  if (!isRecord(value) || !Array.isArray(value.resources))
    invalidServiceIndex('resources must be an array');
  if (value.resources.length > 256)
    invalidServiceIndex('resources exceeds 256 entries');
  const resources = value.resources.map((resource, index) => {
    if (!isRecord(resource))
      invalidServiceIndex(`resources[${index}] must be an object`);
    const id = resource['@id'];
    const rawTypes = resource['@type'];
    const types = Array.isArray(rawTypes) ? rawTypes : [rawTypes];
    if (typeof id !== 'string' || id.length < 1 || id.length > 4096)
      invalidServiceIndex(`resources[${index}].@id is invalid`);
    let url: URL;
    try {
      url = new URL(id);
    } catch {
      invalidServiceIndex(`resources[${index}].@id is not a URL`);
    }
    if (url!.protocol !== 'https:' || url!.username || url!.password)
      invalidServiceIndex(
        `resources[${index}].@id must be HTTPS without credentials`,
      );
    if (
      types.length < 1 ||
      types.length > 16 ||
      types.some(
        (type) =>
          typeof type !== 'string' || type.length < 1 || type.length > 128,
      )
    )
      invalidServiceIndex(`resources[${index}].@type is invalid`);
    return {
      '@id': id,
      '@type': Array.isArray(rawTypes)
        ? // SAFETY: The surrounding boundary establishes the asserted domain contract.
          (types as string[])
        : // SAFETY: The surrounding boundary establishes the asserted domain contract.
          (types[0] as string),
    };
  });
  return { resources };
}

function assertServiceIndexComplexity(root: unknown): void {
  const pending: Array<{ value: unknown; depth: number }> = [
    { value: root, depth: 0 },
  ];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    nodes += 1;
    if (nodes > 4096) invalidServiceIndex('structure exceeds 4096 nodes');
    if (current.depth > 16) invalidServiceIndex('structure exceeds 16 levels');
    if (typeof current.value === 'string' && current.value.length > 4096)
      invalidServiceIndex('string exceeds 4096 characters');
    if (Array.isArray(current.value)) {
      if (current.value.length > 512)
        invalidServiceIndex('array exceeds 512 items');
      for (const value of current.value)
        pending.push({ value, depth: current.depth + 1 });
    } else if (isRecord(current.value)) {
      for (const value of Object.values(current.value))
        pending.push({ value, depth: current.depth + 1 });
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidServiceIndex(message: string): never {
  throw new ProviderError(
    'INVALID_PROVIDER_RESPONSE',
    `Invalid NuGet service index: ${message}`,
  );
}

export class NugetV3Provider implements CatalogProvider {
  readonly providerId = 'nuget-v3';
  readonly capabilities: ProviderCapabilities = {
    operations: ['identify', 'enumerate', 'inspect', 'artifact', 'snapshot'],
    purlTypes: ['nuget'],
    qualifierSupport: 'complete',
    targetSpecificSemantics: true,
    offlineReplay: true,
    extensions: {
      'openpacker.dev/registration': '3.6.0',
      'openpacker.dev/flat-container': '3.0.0',
    },
  };
  readonly #records = new Map<string, ProviderRecord>();
  readonly #artifactSources = new Map<
    string,
    {
      uri: string;
      packageHash?: string;
      packageHashAlgorithm?: string;
      expectedSize?: number;
    }
  >();
  #serviceIndex: ProviderRecord<NugetServiceIndex> | undefined;
  #packageBaseAddress: string | undefined;

  constructor(
    private readonly transport: HttpTransport,
    private readonly clock: Clock,
    private readonly serviceIndexUrl = 'https://api.nuget.org/v3/index.json',
    private readonly codec = new NugetCodec(),
  ) {}

  async identify(query: string): Promise<readonly PackageIdentity[]> {
    const purl = query.startsWith('pkg:')
      ? this.codec.canonicalizePurl(query)
      : this.purlFor(this.codec.parseNativeCoordinate(query));
    return [nugetIdentity(purl, this.serviceIndexUrl)];
  }

  invalidate(purl?: string): void {
    if (purl === undefined) {
      this.#records.clear();
      this.#artifactSources.clear();
      this.#serviceIndex = undefined;
      this.#packageBaseAddress = undefined;
      return;
    }
    const parsed = parsePurl(this.codec.canonicalizePurl(purl));
    const key = formatPurl({ ...parsed, version: undefined });
    for (const recordKey of this.#records.keys()) {
      if (recordKey === key || recordKey.startsWith(`page:${key}:`))
        this.#records.delete(recordKey);
    }
    if (parsed.version !== undefined)
      this.#artifactSources.delete(this.codec.canonicalizePurl(purl));
  }

  async enumerate(
    basePurl: string,
    signal?: AbortSignal,
  ): Promise<readonly string[]> {
    const record = await this.registration(basePurl, signal);
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    return registrationLeaves(record.body as NugetRegistrationIndex)
      .map((leaf) => leaf.catalogEntry.version)
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
        'inspect requires an exact NuGet PURL',
      );
    const record = await this.registration(
      formatPurl({ ...parsed, version: undefined }),
      signal,
    );
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const leaf = registrationLeaves(record.body as NugetRegistrationIndex).find(
      (candidate) =>
        this.codec.compareNativeVersions(
          candidate.catalogEntry.version,
          parsed.version!,
        ) === 0,
    );
    if (!leaf)
      throw new ProviderError(
        'VERSION_NOT_FOUND',
        `${canonical} is absent from registration metadata`,
      );
    const metadataDigest = await canonicalDigest(
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      JSON.parse(JSON.stringify(leaf.catalogEntry)) as JsonValue,
    );
    const translated = await this.codec.translateMetadata(leaf.catalogEntry, {
      providerId: this.providerId,
      endpoint: record.endpoint,
      retrievedAt: record.retrievedAt,
      evaluationTime: record.retrievedAt,
      ...(!(record.etag === undefined) && { etag: record.etag }),
      metadataDigest,
      rawMetadataRef: {
        type: 'provider-metadata',
        locator: `urn:openpacker:nuget:${leaf.catalogEntry.id.toLowerCase()}:${leaf.catalogEntry.version}`,
        digest: metadataDigest,
        mediaType: 'application/json',
      },
    });
    assertPackageIdentityMatchesRequest(
      canonical,
      translated.instance.identity,
    );
    const packageUri =
      leaf.packageContent ??
      (this.#packageBaseAddress === undefined
        ? undefined
        : `${this.#packageBaseAddress.replace(/\/$/, '')}/${encodeUrlPathComponent(parsed.name.toLowerCase(), 'NuGet package ID')}/${encodeUrlPathComponent(parsed.version.toLowerCase(), 'NuGet package version')}/${encodeUrlPathComponent(`${parsed.name.toLowerCase()}.${parsed.version.toLowerCase()}.nupkg`, 'NuGet package filename')}`);
    if (packageUri !== undefined) {
      this.#artifactSources.set(canonical, {
        uri: packageUri,
        ...(!(leaf.catalogEntry.packageHash === undefined) && {
          packageHash: leaf.catalogEntry.packageHash,
        }),
        ...(!(leaf.catalogEntry.packageHashAlgorithm === undefined) && {
          packageHashAlgorithm: leaf.catalogEntry.packageHashAlgorithm,
        }),
        ...(!(leaf.catalogEntry.packageSize === undefined) && {
          expectedSize: leaf.catalogEntry.packageSize,
        }),
      });
    }
    if (translated.instance.artifacts[0] && packageUri !== undefined) {
      translated.instance.artifacts[0].locations = [
        {
          transport: 'https',
          uri: packageUri,
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
    const canonical = this.codec.canonicalizePurl(exactPurl);
    const source = this.#artifactSources.get(canonical);
    if (!source)
      throw new ProviderError(
        'ARTIFACT_NOT_FOUND',
        `No NuGet artifact source for ${exactPurl}`,
      );
    const response = await this.transport.request({
      url: source.uri,
      signal,
      maximumBytes: 128 * 1024 * 1024,
      headers: { accept: 'application/octet-stream' },
    });
    if (response.status < 200 || response.status >= 300)
      throw providerErrorForStatus(response.status);
    if (
      source.expectedSize !== undefined &&
      source.expectedSize !== response.body.byteLength
    )
      throw new ProviderError(
        'SIZE_MISMATCH',
        `NuGet package size ${response.body.byteLength} does not match ${source.expectedSize}`,
      );
    if (
      source.packageHash !== undefined &&
      !(await verifyNativeDigest(
        response.body,
        source.packageHashAlgorithm ?? 'SHA512',
        source.packageHash,
      ))
    )
      throw new ProviderError('DIGEST_MISMATCH', 'NuGet package hash mismatch');
    const parsed = parsePurl(canonical);
    const digest = await sha256(response.body);
    const artifact: ArtifactDescriptor = {
      descriptorId: `${inspection.package.nodeId}:nupkg`,
      digest,
      size: response.body.byteLength,
      mediaType: 'application/zip',
      artifactType: 'application/vnd.openpacker.nuget.nupkg.v1+zip',
      fileName: `${parsed.name}.${parsed.version!}.nupkg`,
      nativeRole: 'package-archive',
      locations: [
        {
          transport: 'https',
          uri: source.uri,
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
          ...(!(record.etag === undefined) && { etag: record.etag }),
          digest: formatDigest(await sha256(record.rawBody)),
        })),
    );
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
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
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const rootDigest = await canonicalDigest({
      providerId: this.providerId,
      providerType: 'nuget-v3',
      endpointIdentity: this.serviceIndexUrl,
      retrievedAt,
      evaluationTime,
      revision,
      ...(!(etag === undefined) && { etag }),
      records,
    } as JsonValue);
    return {
      snapshotId: formatDigest(rootDigest),
      providerId: this.providerId,
      providerType: 'nuget-v3',
      endpointIdentity: this.serviceIndexUrl,
      retrievedAt,
      evaluationTime,
      revision,
      ...(!(etag === undefined) && { etag }),
      rootDigest,
      recordsDigest,
      evidenceRefs: [],
    };
  }

  private purlFor(coordinate: NativeCoordinate): string {
    return this.codec.canonicalizePurl(
      formatPurl({
        type: 'nuget',
        name: coordinate.name,
        version: coordinate.version,
        qualifiers: {},
      }),
    );
  }

  private async registration(
    purl: string,
    signal?: AbortSignal,
  ): Promise<ProviderRecord<NugetRegistrationIndex>> {
    const parsed = parsePurl(this.codec.canonicalizePurl(purl));
    const key = formatPurl({ ...parsed, version: undefined });
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const existing = this.#records.get(key) as
      | ProviderRecord<NugetRegistrationIndex>
      | undefined;
    const service = (await this.serviceIndex(signal)).body;
    const typeMatches = (
      resource: NugetServiceIndex['resources'][number],
      type: string,
    ) =>
      (Array.isArray(resource['@type'])
        ? resource['@type']
        : [resource['@type']]
      ).some((value) => value.startsWith(type));
    const registrationBase = service.resources.find((resource) =>
      typeMatches(resource, 'RegistrationsBaseUrl'),
    )?.['@id'];
    if (!registrationBase)
      throw new ProviderError(
        'PROVIDER_CAPABILITY_MISSING',
        'NuGet service index lacks RegistrationsBaseUrl',
      );
    const url = `${registrationBase.replace(/\/$/, '')}/${encodeUrlPathComponent(parsed.name.toLowerCase(), 'NuGet package ID')}/index.json`;
    const response = await this.transport.request({
      url,
      signal,
      maximumBytes: 8 * 1024 * 1024,
      headers: {
        accept: 'application/json',
        ...(!(existing?.etag === undefined) && {
          'if-none-match': existing.etag,
        }),
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
    let registrationBytes = response.body.byteLength;
    if (registrationBytes > 64 * 1024 * 1024)
      throw new ProviderError(
        'UPSTREAM_RESPONSE_TOO_LARGE',
        'NuGet registration exceeds 64 MiB',
      );
    const index = json<NugetRegistrationIndex>(response);
    const leaves: NugetRegistrationLeaf[] = [];
    let pageCount = 0;
    for (const item of index.items) {
      if ('catalogEntry' in item) leaves.push(item);
      else if (item.items !== undefined) leaves.push(...item.items);
      else if (item['@id'] !== undefined) {
        pageCount += 1;
        if (pageCount > 256)
          throw new ProviderError(
            'UPSTREAM_RESPONSE_TOO_LARGE',
            'NuGet registration exceeds 256 pages',
          );
        const page = await this.registrationPage(key, item['@id'], signal);
        registrationBytes += page.rawBody.byteLength;
        if (registrationBytes > 64 * 1024 * 1024)
          throw new ProviderError(
            'UPSTREAM_RESPONSE_TOO_LARGE',
            'NuGet registration exceeds 64 MiB',
          );
        leaves.push(...(page.body.items ?? []));
      }
      if (leaves.length > 100_000)
        throw new ProviderError(
          'UPSTREAM_RESPONSE_TOO_LARGE',
          'NuGet registration exceeds 100000 leaves',
        );
    }
    const unique = new Map<string, NugetRegistrationLeaf>();
    for (const leaf of leaves) {
      const leafKey = `${leaf.catalogEntry.id.toLowerCase()}@${this.codec.parseNativeVersion(leaf.catalogEntry.version).normalized}`;
      const prior = unique.get(leafKey);
      if (prior && JSON.stringify(prior) !== JSON.stringify(leaf))
        throw new ProviderError(
          'INVALID_PROVIDER_METADATA',
          `Conflicting NuGet registration leaf ${leafKey}`,
        );
      unique.set(leafKey, leaf);
    }
    const flattened: NugetRegistrationIndex = {
      items: [...unique.values()].sort((left, right) => {
        const identity = compareCodePoints(
          left.catalogEntry.id.toLowerCase(),
          right.catalogEntry.id.toLowerCase(),
        );
        return identity === 0
          ? this.codec.compareNativeVersions(
              left.catalogEntry.version,
              right.catalogEntry.version,
            )
          : identity;
      }),
    };
    const record: ProviderRecord<NugetRegistrationIndex> = {
      key,
      endpoint: response.url,
      ...(!(header(response, 'etag') === undefined) && {
        etag: header(response, 'etag'),
      }),
      body: flattened,
      rawBody: response.body,
      retrievedAt: this.clock.now(),
    };
    this.#records.set(record.key, record);
    return record;
  }

  private async serviceIndex(
    signal?: AbortSignal,
  ): Promise<ProviderRecord<NugetServiceIndex>> {
    const response = await this.transport.request({
      url: this.serviceIndexUrl,
      signal,
      maximumBytes: 1024 * 1024,
      headers: {
        accept: 'application/json',
        ...(!(this.#serviceIndex?.etag === undefined) && {
          'if-none-match': this.#serviceIndex.etag,
        }),
      },
    });
    if (response.status === 304) {
      if (!this.#serviceIndex)
        throw new ProviderError(
          'STALE_METADATA',
          'Received 304 without cached NuGet service index',
          304,
        );
      return this.#serviceIndex;
    }
    const body = parseNugetServiceIndex(response.body);
    const typeMatches = (
      resource: NugetServiceIndex['resources'][number],
      type: string,
    ) =>
      (Array.isArray(resource['@type'])
        ? resource['@type']
        : [resource['@type']]
      ).some((value) => value.startsWith(type));
    this.#packageBaseAddress = body.resources.find((resource) =>
      typeMatches(resource, 'PackageBaseAddress'),
    )?.['@id'];
    const record: ProviderRecord<NugetServiceIndex> = {
      key: 'service-index',
      endpoint: response.url,
      ...(!(header(response, 'etag') === undefined) && {
        etag: header(response, 'etag'),
      }),
      body,
      rawBody: response.body,
      retrievedAt: this.clock.now(),
    };
    this.#serviceIndex = record;
    this.#records.set(record.key, record);
    return record;
  }

  private async registrationPage(
    packageKey: string,
    url: string,
    signal?: AbortSignal,
  ): Promise<ProviderRecord<NugetRegistrationPage>> {
    const key = `page:${packageKey}:${url}`;
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const existing = this.#records.get(key) as
      | ProviderRecord<NugetRegistrationPage>
      | undefined;
    const response = await this.transport.request({
      url,
      signal,
      maximumBytes: 8 * 1024 * 1024,
      headers: {
        accept: 'application/json',
        ...(!(existing?.etag === undefined) && {
          'if-none-match': existing.etag,
        }),
      },
    });
    if (response.status === 304) {
      if (!existing)
        throw new ProviderError(
          'STALE_METADATA',
          `Received 304 without cached NuGet page ${url}`,
          304,
        );
      return existing;
    }
    const record: ProviderRecord<NugetRegistrationPage> = {
      key,
      endpoint: response.url,
      ...(!(header(response, 'etag') === undefined) && {
        etag: header(response, 'etag'),
      }),
      body: json<NugetRegistrationPage>(response),
      rawBody: response.body,
      retrievedAt: this.clock.now(),
    };
    this.#records.set(key, record);
    return record;
  }
}

function nugetPathComponent(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u.test(value))
    throw new ProviderError('INVALID_PURL', `Invalid NuGet ${label}`);
  encodeUrlPathComponent(value, `NuGet ${label}`);
  return value.toLowerCase();
}

export { NugetProjectFormat } from './project.js';
