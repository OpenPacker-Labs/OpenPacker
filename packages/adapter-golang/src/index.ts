import { canonicalDigest, formatDigest, sha256 } from '@openpacker/canonical';
import type {
  ArtifactDescriptor,
  JsonValue,
  PackageIdentity,
  PackageInstance,
  Requirement,
  SemanticLoss,
  SourceSnapshot,
  TargetPredicate,
  VersionConstraint,
} from '@openpacker/contracts';
import {
  compareParsedVersions,
  compareCodePoints,
  evaluateSemverRange,
  formatPurl,
  header,
  parsePurl,
  parseSemver,
  parseSemverRange,
  ProviderError,
  providerErrorForStatus,
  rangeToConstraint,
  semanticLoss,
  sourceRef,
  text,
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
  type ProviderWarning,
  type TranslatedMetadata,
  type TranslationProvenance,
} from '@openpacker/adapter-core';

export interface GolangRequire {
  path: string;
  version: string;
  indirect?: boolean;
}

export interface GolangModuleVersionMetadata {
  path: string;
  version: string;
  time?: string;
  go?: string;
  requires?: GolangRequire[];
  /** Exact OS/arch build constraints only; complex tags become SemanticLoss. */
  buildConstraints?: string[];
  /** Native go.sum h1 digest form, e.g. h1:base64... */
  h1?: string;
  size?: number;
  retracted?: boolean;
  [key: string]: unknown;
}

export interface GolangSumEntry {
  path: string;
  version: string;
  kind: 'module' | 'go.mod';
  digest: string;
}

export interface GolangSumDocument {
  entries: GolangSumEntry[];
}

export interface GolangModDocument {
  module?: string;
  go?: string;
  requires: GolangRequire[];
}

export type GolangLockInput =
  | string
  | GolangSumDocument
  | { format: 'go.sum'; data: string | GolangSumDocument }
  | { format: 'go.mod'; data: string | GolangModDocument };

const GO_OS = new Set([
  'aix',
  'android',
  'darwin',
  'dragonfly',
  'freebsd',
  'hurd',
  'illumos',
  'ios',
  'js',
  'linux',
  'nacl',
  'netbsd',
  'openbsd',
  'plan9',
  'solaris',
  'windows',
  'zos',
]);

const GO_ARCH = new Set([
  '386',
  'amd64',
  'amd64p32',
  'arm',
  'arm64',
  'arm64be',
  'armbe',
  'loong64',
  'mips',
  'mips64',
  'mips64le',
  'mips64p32',
  'mips64p32le',
  'mipsle',
  'ppc',
  'ppc64',
  'ppc64le',
  'riscv',
  'riscv64',
  's390',
  's390x',
  'sparc',
  'sparc64',
  'wasm',
]);

function isPseudoVersion(version: string): boolean {
  const value = version.startsWith('v') ? version : `v${version}`;
  return (
    /^v\d+\.\d+\.\d+-\d{14}-[0-9a-f]{12}$/.test(value) ||
    /^v\d+\.\d+\.\d+-0\.\d{14}-[0-9a-f]{12}$/.test(value) ||
    /^v\d+\.\d+\.\d+-[0-9A-Za-z.-]+\.0\.\d{14}-[0-9a-f]{12}$/.test(value)
  );
}

/** Encode a module path/version for proxy.golang.org-style paths. */
export function encodeGoModulePath(path: string): string {
  return path.replace(/[A-Z]/g, (character) => `!${character.toLowerCase()}`);
}

export function modulePathFromParts(
  namespace: string | undefined,
  name: string,
): string {
  return namespace === undefined || namespace === ''
    ? name
    : `${namespace}/${name}`;
}

export function splitModulePath(path: string): {
  namespace?: string;
  name: string;
} {
  const segments = path.split('/').filter(Boolean);
  if (segments.length === 0)
    throw new ProviderError(
      'INVALID_NATIVE_COORDINATE',
      `Empty Go module path: ${path}`,
    );
  const name = segments.pop()!;
  if (segments.length === 0) return { name };
  return { namespace: segments.join('/'), name };
}

function purlForModule(path: string, version?: string): string {
  const parts = splitModulePath(path);
  return formatPurl({
    type: 'golang',
    ...(parts.namespace === undefined ? {} : { namespace: parts.namespace }),
    name: parts.name,
    ...(version === undefined ? {} : { version }),
    qualifiers: {},
  });
}

function golangIdentity(exactPurl: string, endpoint?: string): PackageIdentity {
  const parsed = parsePurl(exactPurl);
  const coordinate = modulePathFromParts(parsed.namespace, parsed.name);
  const identity: PackageIdentity = {
    canonicalPurl: formatPurl({ ...parsed, version: undefined }),
    purlType: 'golang',
    name: parsed.name,
    qualifiers: { ...parsed.qualifiers },
    nativeCoordinates: [
      {
        ecosystem: 'golang',
        coordinate,
        ...(parsed.version === undefined ? {} : { version: parsed.version }),
      },
    ],
    aliases: [],
    sourceRefs: endpoint === undefined ? [] : [sourceRef('golang', endpoint)],
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

function normalizeGoVersionText(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0)
    throw new ProviderError('INVALID_NATIVE_VERSION', 'Empty Go version');
  return trimmed.startsWith('v') ? trimmed : `v${trimmed}`;
}

/**
 * Parse a simple build constraint into an exact target predicate.
 * Returns undefined when the expression cannot be represented exactly
 * (complex tags, cgo, go version, negation, parentheses, etc.).
 */
export function parseExactBuildConstraint(
  expression: string,
): TargetPredicate | undefined {
  const cleaned = expression
    .replace(/^\/\/\s*go:build\s+/, '')
    .replace(/^\/\/\s*\+build\s+/, '')
    .trim();
  if (cleaned.length === 0) return undefined;
  if (/[()!]/.test(cleaned) || /\b(cgo|go1\.\d+)\b/i.test(cleaned))
    return undefined;

  const orParts = cleaned.split(/\s*\|\|\s*/);
  if (orParts.length > 1) {
    const osValues: string[] = [];
    const archValues: string[] = [];
    for (const part of orParts) {
      if (/\s|&&/.test(part)) return undefined;
      const token = part.trim();
      if (GO_OS.has(token)) osValues.push(token);
      else if (GO_ARCH.has(token)) archValues.push(token);
      else return undefined;
    }
    if (osValues.length > 0 && archValues.length > 0) return undefined;
    if (osValues.length > 0)
      return osValues.length === 1
        ? { type: 'equals', path: 'os', value: osValues[0]! }
        : { type: 'in', path: 'os', values: osValues };
    if (archValues.length > 0)
      return archValues.length === 1
        ? { type: 'equals', path: 'architecture', value: archValues[0]! }
        : { type: 'in', path: 'architecture', values: archValues };
    return undefined;
  }

  const andParts = cleaned.split(/\s*&&\s*/).map((part) => part.trim());
  if (andParts.some((part) => part.length === 0 || /\s/.test(part)))
    return undefined;
  const predicates: TargetPredicate[] = [];
  for (const token of andParts) {
    if (GO_OS.has(token))
      predicates.push({ type: 'equals', path: 'os', value: token });
    else if (GO_ARCH.has(token))
      predicates.push({ type: 'equals', path: 'architecture', value: token });
    else return undefined;
  }
  if (predicates.length === 0) return undefined;
  return predicates.length === 1
    ? predicates[0]
    : { type: 'allOf', predicates };
}

export function parseGoSum(input: string): GolangSumDocument {
  const entries: GolangSumEntry[] = [];
  for (const [index, rawLine] of input.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const match = /^(\S+)\s+(\S+)\s+(h1:[A-Za-z0-9+/=]+)\s*$/.exec(line);
    if (!match)
      throw new ProviderError(
        'INVALID_LOCKFILE',
        `Invalid go.sum line ${index + 1}`,
      );
    const path = match[1]!;
    const versionField = match[2]!;
    const digest = match[3]!;
    const isGoMod = versionField.endsWith('/go.mod');
    const version = isGoMod
      ? versionField.slice(0, -'/go.mod'.length)
      : versionField;
    entries.push({
      path,
      version: normalizeGoVersionText(version),
      kind: isGoMod ? 'go.mod' : 'module',
      digest,
    });
  }
  return { entries };
}

export function parseGoMod(input: string): GolangModDocument {
  const requires: GolangRequire[] = [];
  let module: string | undefined;
  let go: string | undefined;
  let inRequireBlock = false;

  for (const [index, rawLine] of input.split(/\r?\n/).entries()) {
    const withoutComment = rawLine.replace(/\s*\/\/.*$/, '');
    const line = withoutComment.trim();
    if (line.length === 0) continue;

    if (!inRequireBlock) {
      const moduleMatch = /^module\s+(\S+)\s*$/.exec(line);
      if (moduleMatch) {
        module = moduleMatch[1];
        continue;
      }
      const goMatch = /^go\s+(\S+)\s*$/.exec(line);
      if (goMatch) {
        go = goMatch[1];
        continue;
      }
      const singleRequire =
        /^require\s+(\S+)\s+(\S+)\s*$/.exec(line) ??
        /^require\s+(\S+)\s+(\S+)\s+\/\/\s*indirect\s*$/.exec(
          withoutComment.trim(),
        );
      if (singleRequire && !line.endsWith('(')) {
        requires.push({
          path: singleRequire[1]!,
          version: normalizeGoVersionText(singleRequire[2]!),
          indirect: /\/\/\s*indirect/.test(rawLine),
        });
        continue;
      }
      if (/^require\s*\(\s*$/.test(line)) {
        inRequireBlock = true;
        continue;
      }
      // Ignore other directives (replace, exclude, retract, toolchain, etc.)
      continue;
    }

    if (line === ')') {
      inRequireBlock = false;
      continue;
    }
    const entry = /^(\S+)\s+(\S+)\s*$/.exec(line);
    if (!entry)
      throw new ProviderError(
        'INVALID_LOCKFILE',
        `Invalid go.mod require at line ${index + 1}`,
      );
    requires.push({
      path: entry[1]!,
      version: normalizeGoVersionText(entry[2]!),
      indirect: /\/\/\s*indirect/.test(rawLine),
    });
  }

  if (inRequireBlock)
    throw new ProviderError(
      'INVALID_LOCKFILE',
      'Unterminated require block in go.mod',
    );

  return {
    ...(module === undefined ? {} : { module }),
    ...(go === undefined ? {} : { go }),
    requires,
  };
}

export class GolangCodec
  implements EcosystemCodec<GolangModuleVersionMetadata, GolangLockInput>
{
  readonly purlType = 'golang' as const;

  parseNativeCoordinate(value: string): NativeCoordinate {
    const trimmed = value.trim();
    const at = trimmed.lastIndexOf('@');
    const path = at < 0 ? trimmed : trimmed.slice(0, at);
    const version = at < 0 ? undefined : trimmed.slice(at + 1);
    if (
      path.length === 0 ||
      path.includes(' ') ||
      path.startsWith('/') ||
      path.endsWith('/')
    )
      throw new ProviderError(
        'INVALID_NATIVE_COORDINATE',
        `Invalid Go module coordinate: ${value}`,
      );
    const parts = splitModulePath(path);
    return {
      ecosystem: 'golang',
      name: parts.name,
      original: value,
      ...(parts.namespace === undefined ? {} : { namespace: parts.namespace }),
      ...(version === undefined
        ? {}
        : { version: normalizeGoVersionText(version) }),
    };
  }

  canonicalizePurl(value: string): string {
    const parsed = parsePurl(value);
    if (parsed.type !== 'golang')
      throw new ProviderError(
        'INVALID_PURL',
        `Expected golang PURL, received ${parsed.type}`,
      );
    const path = modulePathFromParts(parsed.namespace, parsed.name);
    if (path.length === 0)
      throw new ProviderError('INVALID_PURL', 'Go PURL path is empty');
    return formatPurl({
      ...parsed,
      type: 'golang',
      ...(parsed.namespace === undefined
        ? {}
        : { namespace: parsed.namespace }),
      name: parsed.name,
      ...(parsed.version === undefined
        ? {}
        : { version: this.parseNativeVersion(parsed.version).normalized }),
    });
  }

  parseNativeVersion(value: string): ParsedVersion {
    const original = value.trim();
    const withV = normalizeGoVersionText(original);
    // Strip leading v for semver parse while preserving +incompatible etc.
    const semverBody = withV.startsWith('v') ? withV.slice(1) : withV;
    const parsed = parseSemver(semverBody, 3);
    const release = parsed.release;
    const prerelease = parsed.prerelease;
    const build = parsed.build;
    const normalized = `v${release.join('.')}${
      prerelease.length === 0 ? '' : `-${prerelease.join('.')}`
    }${build.length === 0 ? '' : `+${build.join('.')}`}`;
    return {
      original,
      normalized,
      release,
      prerelease,
      build,
    };
  }

  compareNativeVersions(left: string, right: string): number {
    return compareParsedVersions(
      this.parseNativeVersion(left),
      this.parseNativeVersion(right),
    );
  }

  parseNativeRange(value: string): ParsedRange {
    const trimmed = value.trim();
    // Go module requirements are concrete versions (MVS floors), not ranges.
    // Explicit comparison / multi-clause forms reuse the shared semver parser.
    if (
      trimmed === '' ||
      trimmed === '*' ||
      /^(<=|>=|!=|=|<|>|\^|~)/.test(trimmed) ||
      trimmed.includes('||') ||
      trimmed.includes(',') ||
      /\s/.test(trimmed)
    ) {
      return parseSemverRange(trimmed === '' ? '*' : trimmed, {
        scheme: 'golang',
        bare: 'exact',
      });
    }
    const version = this.parseNativeVersion(trimmed);
    const losses: SemanticLoss[] = [];
    if (isPseudoVersion(version.normalized)) {
      losses.push(
        semanticLoss(
          'golang',
          'GOLANG_PSEUDO_VERSION_ORDER_APPROXIMATE',
          '/range',
          'Pseudo-version ordering follows the constructed semver form and may not reflect full VCS history',
          'Compared as a Go module pseudo-version semver equivalent',
        ),
      );
    }
    const body = `=${version.normalized}`;
    return {
      scheme: 'golang',
      original: value,
      normalized: `=${version.normalized}`,
      ast: {
        type: 'comparison',
        operator: '=',
        version: version.normalized,
      },
      vers: `vers:golang/${body}`,
      reversible: true,
      semanticLoss: losses,
    };
  }

  toVers(value: string): VersionConstraint {
    return rangeToConstraint(this.parseNativeRange(value));
  }

  satisfies(version: string, range: string | ParsedRange): boolean {
    const parsedRange =
      typeof range === 'string' ? this.parseNativeRange(range) : range;
    const normalizedVersion = this.parseNativeVersion(version).normalized;
    return evaluateSemverRange(
      normalizedVersion,
      parsedRange.ast,
      (left, right) => this.compareNativeVersions(left, right),
    );
  }

  async translateMetadata(
    metadata: GolangModuleVersionMetadata,
    provenance: TranslationProvenance,
  ): Promise<TranslatedMetadata> {
    const version = this.parseNativeVersion(metadata.version).normalized;
    const exactPurl = this.canonicalizePurl(
      purlForModule(metadata.path, version),
    );
    const nodeId = formatDigest(await canonicalDigest(exactPurl));
    const losses: SemanticLoss[] = [];
    if (isPseudoVersion(version)) {
      losses.push(
        semanticLoss(
          'golang',
          'GOLANG_PSEUDO_VERSION_ORDER_APPROXIMATE',
          '/version',
          'Pseudo-version ordering follows the constructed semver form and may not reflect full VCS history',
          'Ordered by Go module pseudo-version encoding',
        ),
      );
    }

    const requirements: Requirement[] = (metadata.requires ?? [])
      .map((dependency, index) => {
        const depVersion = this.parseNativeVersion(dependency.version);
        const range = this.parseNativeRange(depVersion.normalized);
        const depPurl = this.canonicalizePurl(purlForModule(dependency.path));
        return {
          id: `${nodeId}:runtime:${dependency.path}:${index}`,
          dependerNodeId: nodeId,
          expression: {
            type: 'package',
            purl: depPurl,
            ...(range.vers === undefined ? {} : { vers: range.vers }),
          },
          kind: 'runtime',
          optional: false,
          source: sourceRef('golang', provenance.endpoint),
          authority: 'native',
          raw: dependency as unknown as JsonValue,
          nativeSemantics: {
            version: 'golang-v1',
            data: {
              path: dependency.path,
              version: depVersion.normalized,
              indirect: dependency.indirect === true,
              mvsFloor: true,
            } as JsonValue,
          },
          semanticLoss: [
            ...range.semanticLoss,
            semanticLoss(
              'golang',
              'GOLANG_MVS_REQUIRE_IS_FLOOR',
              `/requires/${index}`,
              'Go module requires are MVS version floors, not closed intervals',
              'Represented as an exact selected version when present in lock data; metadata retains the floor',
            ),
          ],
        } satisfies Requirement;
      })
      .sort((left, right) => compareCodePoints(left.id, right.id));

    let targetPredicate: TargetPredicate | undefined;
    for (const [index, constraint] of (
      metadata.buildConstraints ?? []
    ).entries()) {
      const exact = parseExactBuildConstraint(constraint);
      if (exact === undefined) {
        losses.push(
          semanticLoss(
            'golang',
            'GOLANG_BUILD_CONSTRAINT_NOT_EXACT',
            `/buildConstraints/${index}`,
            `Build constraint ${constraint} is not an exact OS/arch predicate and is preserved natively only`,
            undefined,
            'error',
          ),
        );
        continue;
      }
      if (targetPredicate === undefined) targetPredicate = exact;
      else
        targetPredicate = {
          type: 'allOf',
          predicates: [targetPredicate, exact],
        };
    }

    // h1 is a module content-tree hash, not OpenPacker sha256(zip). Artifact
    // descriptors are filled only after fetchArtifactRecord hashes zip bytes.
    const artifacts: ArtifactDescriptor[] = [];
    if (metadata.h1 !== undefined) {
      losses.push(
        semanticLoss(
          'golang',
          'GOLANG_H1_NOT_SHA256',
          '/h1',
          'go.sum h1 digests hash the module content tree, not a transferable OpenPacker sha256 of the zip bytes',
          'Native h1 form is retained in nativeSemantics and lock artifactDigest',
        ),
      );
    }

    const instance: PackageInstance = {
      nodeId,
      identity: golangIdentity(exactPurl, provenance.endpoint),
      nativeVersion: metadata.version,
      normalizedVersion: version,
      versionSortKey: version,
      requirements,
      capabilities: [],
      conflicts: [],
      cardinalityConstraints: [],
      artifacts,
      lifecycle: {
        status: metadata.retracted ? 'yanked' : 'published',
        eligible: !metadata.retracted,
        warnings: metadata.retracted
          ? [
              {
                code: 'GOLANG_RETRACTED',
                message: 'Version is retracted in module metadata',
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
        version: 'golang-v1',
        data: {
          path: metadata.path,
          version,
          ...(metadata.time === undefined ? {} : { time: metadata.time }),
          ...(metadata.go === undefined ? {} : { go: metadata.go }),
          requires: metadata.requires ?? [],
          buildConstraints: metadata.buildConstraints ?? [],
          ...(targetPredicate === undefined ? {} : { targetPredicate }),
          ...(metadata.h1 === undefined ? {} : { h1: metadata.h1 }),
          ...(metadata.size === undefined ? {} : { size: metadata.size }),
          moduleCodeExecuted: false,
        } as unknown as JsonValue,
      },
      semanticLoss: losses,
    };
    if (provenance.rawMetadataRef !== undefined)
      instance.rawMetadataRef = provenance.rawMetadataRef;
    return { instance, rawMetadata: metadata };
  }

  translateLockResult(
    lockInput: GolangLockInput,
    provenance: TranslationProvenance,
  ): LockCapture {
    if (typeof lockInput === 'string') {
      return this.captureGoSum(parseGoSum(lockInput), provenance);
    }
    if ('entries' in lockInput) {
      return this.captureGoSum(lockInput, provenance);
    }
    if (lockInput.format === 'go.sum') {
      const document =
        typeof lockInput.data === 'string'
          ? parseGoSum(lockInput.data)
          : lockInput.data;
      return this.captureGoSum(document, provenance);
    }
    const document =
      typeof lockInput.data === 'string'
        ? parseGoMod(lockInput.data)
        : lockInput.data;
    return this.captureGoMod(document, provenance);
  }

  private captureGoSum(
    document: GolangSumDocument,
    provenance: TranslationProvenance,
  ): LockCapture {
    const byKey = new Map<
      string,
      {
        path: string;
        version: string;
        moduleDigest?: string;
        goModDigest?: string;
      }
    >();
    const losses: SemanticLoss[] = [];
    for (const entry of document.entries) {
      const key = `${entry.path}@${entry.version}`;
      const current = byKey.get(key) ?? {
        path: entry.path,
        version: entry.version,
      };
      if (entry.kind === 'module') current.moduleDigest = entry.digest;
      else current.goModDigest = entry.digest;
      byKey.set(key, current);
      if (isPseudoVersion(entry.version)) {
        losses.push(
          semanticLoss(
            'golang',
            'GOLANG_PSEUDO_VERSION_ORDER_APPROXIMATE',
            `/entries/${entry.path}@${entry.version}`,
            'Pseudo-version present in go.sum; ordering follows constructed semver form',
          ),
        );
      }
      if (entry.kind === 'module' && entry.digest.startsWith('h1:')) {
        losses.push(
          semanticLoss(
            'golang',
            'GOLANG_H1_NOT_SHA256',
            `/entries/${entry.path}@${entry.version}`,
            'go.sum h1 digests are module content-tree hashes, not OpenPacker sha256 zip digests',
            'Stored as native artifactDigest form',
          ),
        );
      }
    }

    const packages = [...byKey.values()]
      .map((entry) => {
        const exactPurl = this.canonicalizePurl(
          purlForModule(entry.path, entry.version),
        );
        return {
          exactPurl,
          nativeCoordinate: `${entry.path}@${entry.version}`,
          ...(entry.moduleDigest === undefined
            ? {}
            : { artifactDigest: entry.moduleDigest }),
          dependencies: {},
          native: {
            path: entry.path,
            version: entry.version,
            ...(entry.moduleDigest === undefined
              ? {}
              : { h1: entry.moduleDigest }),
            ...(entry.goModDigest === undefined
              ? {}
              : { goModH1: entry.goModDigest }),
          },
        };
      })
      .sort((left, right) =>
        compareCodePoints(left.exactPurl, right.exactPurl),
      );

    // Deduplicate semantic loss codes by path for stability
    const uniqueLosses = [
      ...new Map(
        losses.map((loss) => [`${loss.code}:${loss.sourcePath}`, loss]),
      ).values(),
    ];

    return {
      format: 'go.sum',
      formatVersion: '1',
      sourceDigest: formatDigest(provenance.metadataDigest),
      packages,
      semanticLoss: uniqueLosses,
    };
  }

  private captureGoMod(
    document: GolangModDocument,
    provenance: TranslationProvenance,
  ): LockCapture {
    const losses: SemanticLoss[] = [
      semanticLoss(
        'golang',
        'GOLANG_GOMOD_IS_SECONDARY_LOCK',
        '/',
        'go.mod require blocks list MVS floors and are not a complete freeze; go.sum is the primary lock format',
        'Captured require entries as selected coordinates without artifact digests',
        'error',
      ),
    ];
    const packages = document.requires
      .map((entry) => {
        const version = this.parseNativeVersion(entry.version).normalized;
        if (isPseudoVersion(version)) {
          losses.push(
            semanticLoss(
              'golang',
              'GOLANG_PSEUDO_VERSION_ORDER_APPROXIMATE',
              `/require/${entry.path}`,
              'Pseudo-version present in go.mod; ordering follows constructed semver form',
            ),
          );
        }
        return {
          exactPurl: this.canonicalizePurl(purlForModule(entry.path, version)),
          nativeCoordinate: `${entry.path}@${version}`,
          dependencies: {},
          native: {
            path: entry.path,
            version,
            indirect: entry.indirect === true,
            module: document.module,
            go: document.go,
          },
        };
      })
      .sort((left, right) =>
        compareCodePoints(left.exactPurl, right.exactPurl),
      );
    return {
      format: 'go.mod',
      formatVersion: document.go ?? 'unknown',
      sourceDigest: formatDigest(provenance.metadataDigest),
      packages,
      semanticLoss: losses,
    };
  }
}

export interface GolangProxyInfo {
  Version: string;
  Time?: string;
}

export class GolangProxyProvider implements CatalogProvider {
  readonly providerId = 'golang-proxy';
  readonly capabilities: ProviderCapabilities = {
    operations: ['identify', 'enumerate', 'inspect', 'artifact', 'snapshot'],
    purlTypes: ['golang'],
    qualifierSupport: 'complete',
    targetSpecificSemantics: true,
    offlineReplay: true,
    extensions: { 'openpacker.dev/golang-proxy': 'v1' },
  };
  readonly #listRecords = new Map<string, ProviderRecord<readonly string[]>>();
  readonly #infoRecords = new Map<
    string,
    ProviderRecord<GolangModuleVersionMetadata>
  >();
  readonly #modWarnings = new Map<string, readonly ProviderWarning[]>();

  constructor(
    private readonly transport: HttpTransport,
    private readonly clock: Clock,
    private readonly endpoint = 'https://proxy.golang.org',
    private readonly codec = new GolangCodec(),
  ) {}

  async identify(query: string): Promise<readonly PackageIdentity[]> {
    const purl = query.startsWith('pkg:')
      ? this.codec.canonicalizePurl(query)
      : this.purlFor(this.codec.parseNativeCoordinate(query));
    return [golangIdentity(purl, this.endpoint)];
  }

  invalidate(purl?: string): void {
    if (purl === undefined) {
      this.#listRecords.clear();
      this.#infoRecords.clear();
      this.#modWarnings.clear();
      return;
    }
    const parsed = parsePurl(this.codec.canonicalizePurl(purl));
    const base = formatPurl({ ...parsed, version: undefined });
    this.#listRecords.delete(base);
    for (const key of [...this.#infoRecords.keys()]) {
      if (key === base || key.startsWith(`${base}@`)) {
        this.#infoRecords.delete(key);
        this.#modWarnings.delete(key);
      }
    }
  }

  async enumerate(
    basePurl: string,
    signal?: AbortSignal,
  ): Promise<readonly string[]> {
    const record = await this.listRecord(basePurl, signal);
    return [...record.body]
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
        'inspect requires an exact golang PURL',
      );
    const record = await this.versionRecord(canonical, signal);
    const metadataDigest = await canonicalDigest(
      record.body as unknown as JsonValue,
    );
    const translated = await this.codec.translateMetadata(record.body, {
      providerId: this.providerId,
      endpoint: record.endpoint,
      retrievedAt: record.retrievedAt,
      evaluationTime: record.retrievedAt,
      ...(record.etag === undefined ? {} : { etag: record.etag }),
      metadataDigest,
      rawMetadataRef: {
        type: 'provider-metadata',
        locator: `urn:openpacker:golang:${modulePathFromParts(parsed.namespace, parsed.name)}:${parsed.version}`,
        digest: metadataDigest,
        mediaType: 'application/json',
      },
    });
    if (translated.instance.artifacts[0]) {
      const path = modulePathFromParts(parsed.namespace, parsed.name);
      translated.instance.artifacts[0].locations = [
        {
          transport: 'https',
          uri: this.moduleUrl(path, `@v/${parsed.version}.zip`),
          priority: 0,
          rangeSupported: true,
        },
      ];
    } else {
      // Attach download location via nativeSemantics even without sha256 artifact
      const data = translated.instance.nativeSemantics.data as Record<
        string,
        JsonValue
      >;
      data.downloadUrl = this.moduleUrl(
        modulePathFromParts(parsed.namespace, parsed.name),
        `@v/${parsed.version}.zip`,
      );
    }
    return {
      package: translated.instance,
      record,
      warnings: this.#modWarnings.get(canonical) ?? [],
    };
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
        `No exact module coordinate for ${exactPurl}`,
      );
    const path = modulePathFromParts(parsed.namespace, parsed.name);
    const url = this.moduleUrl(path, `@v/${parsed.version}.zip`);
    const response = await this.transport.request({
      url,
      signal,
      maximumBytes: 128 * 1024 * 1024,
      headers: { accept: 'application/zip, application/octet-stream' },
    });
    if (response.status < 200 || response.status >= 300)
      throw providerErrorForStatus(response.status);
    const digest = await sha256(response.body);
    const expectedSize = (
      inspection.package.nativeSemantics.data as Record<string, JsonValue>
    ).size;
    if (
      typeof expectedSize === 'number' &&
      expectedSize !== response.body.byteLength
    )
      throw new ProviderError(
        'SIZE_MISMATCH',
        `Go module zip size ${response.body.byteLength} does not match ${expectedSize}`,
      );
    const artifact: ArtifactDescriptor = {
      descriptorId: `${inspection.package.nodeId}:module-zip`,
      digest,
      size: response.body.byteLength,
      mediaType: 'application/zip',
      artifactType: 'application/vnd.openpacker.golang.module.v1+zip',
      fileName: `${parsed.name}-${parsed.version}.zip`,
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
    const allRecords = [
      ...this.#listRecords.values(),
      ...this.#infoRecords.values(),
    ];
    const records = await Promise.all(
      allRecords
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
        allRecords
          .map((record) => record.etag)
          .filter((etag): etag is string => etag !== undefined),
      ),
    ];
    const etag = etags.length === 1 ? etags[0] : undefined;
    const retrievedAt =
      allRecords
        .map((record) => record.retrievedAt)
        .sort()
        .at(-1) ?? evaluationTime;
    const rootDigest = await canonicalDigest({
      providerId: this.providerId,
      providerType: 'golang-proxy',
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
      providerType: 'golang-proxy',
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
      purlForModule(
        modulePathFromParts(coordinate.namespace, coordinate.name),
        coordinate.version,
      ),
    );
  }

  private moduleUrl(modulePath: string, suffix: string): string {
    const base = this.endpoint.replace(/\/$/, '');
    return `${base}/${encodeGoModulePath(modulePath)}/${suffix.replace(/^\//, '')}`;
  }

  private async listRecord(
    purl: string,
    signal?: AbortSignal,
  ): Promise<ProviderRecord<readonly string[]>> {
    const parsed = parsePurl(this.codec.canonicalizePurl(purl));
    const key = formatPurl({ ...parsed, version: undefined });
    const existing = this.#listRecords.get(key);
    const path = modulePathFromParts(parsed.namespace, parsed.name);
    const url = this.moduleUrl(path, '@v/list');
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
          `Received 304 without cached list for ${key}`,
          304,
        );
      const revalidated = { ...existing, retrievedAt: this.clock.now() };
      this.#listRecords.set(key, revalidated);
      return revalidated;
    }
    if (response.status < 200 || response.status >= 300)
      throw new ProviderError(
        'UPSTREAM_UNAVAILABLE',
        `Go module proxy list returned ${response.status}`,
        response.status,
      );
    const versions = text(response)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((version) => this.codec.parseNativeVersion(version).normalized);
    if (versions.length > 100_000)
      throw new ProviderError(
        'UPSTREAM_RESPONSE_TOO_LARGE',
        'Go module version list exceeds 100000 entries',
      );
    const record: ProviderRecord<readonly string[]> = {
      key,
      endpoint: response.url,
      ...(header(response, 'etag') === undefined
        ? {}
        : { etag: header(response, 'etag') }),
      body: versions,
      rawBody: response.body,
      retrievedAt: this.clock.now(),
    };
    this.#listRecords.set(record.key, record);
    return record;
  }

  private async versionRecord(
    exactPurl: string,
    signal?: AbortSignal,
  ): Promise<ProviderRecord<GolangModuleVersionMetadata>> {
    const canonical = this.codec.canonicalizePurl(exactPurl);
    const existing = this.#infoRecords.get(canonical);
    if (existing) return existing;

    const parsed = parsePurl(canonical);
    if (!parsed.version)
      throw new ProviderError(
        'VERSION_NOT_FOUND',
        'version record requires an exact PURL',
      );
    const path = modulePathFromParts(parsed.namespace, parsed.name);
    const version = parsed.version;
    const infoUrl = this.moduleUrl(path, `@v/${version}.info`);
    const modUrl = this.moduleUrl(path, `@v/${version}.mod`);
    const infoResponse = await this.transport.request({
      url: infoUrl,
      signal,
      maximumBytes: 1024 * 1024,
      headers: { accept: 'application/json' },
    });
    if (infoResponse.status < 200 || infoResponse.status >= 300)
      throw new ProviderError(
        'VERSION_NOT_FOUND',
        `Go module proxy info returned ${infoResponse.status}`,
        infoResponse.status,
      );
    let info: GolangProxyInfo;
    try {
      info = JSON.parse(text(infoResponse)) as GolangProxyInfo;
    } catch {
      throw new ProviderError(
        'INVALID_PROVIDER_METADATA',
        'Invalid Go module .info JSON',
      );
    }

    let requires: GolangRequire[] = [];
    let go: string | undefined;
    let modText: string | undefined;
    const warnings: ProviderWarning[] = [];
    const modResponse = await this.transport.request({
      url: modUrl,
      signal,
      maximumBytes: 2 * 1024 * 1024,
      headers: { accept: 'text/plain' },
    });
    if (modResponse.status >= 200 && modResponse.status < 300) {
      modText = text(modResponse);
      let mod;
      try {
        mod = parseGoMod(modText);
      } catch (error) {
        if (error instanceof ProviderError && error.code === 'INVALID_LOCKFILE')
          throw new ProviderError('INVALID_PROVIDER_METADATA', error.message);
        throw error;
      }
      requires = mod.requires;
      go = mod.go;
    } else if (modResponse.status === 404 || modResponse.status === 410) {
      warnings.push({
        code: 'GOLANG_MOD_NOT_AVAILABLE',
        message:
          'Go module proxy has no .mod for this version; dependencies are unknown, not empty',
      });
    } else {
      throw new ProviderError(
        'UPSTREAM_UNAVAILABLE',
        `Go module proxy .mod returned ${modResponse.status}`,
        modResponse.status,
      );
    }
    this.#modWarnings.set(canonical, warnings);

    const metadata: GolangModuleVersionMetadata = {
      path,
      version: this.codec.parseNativeVersion(info.Version ?? version)
        .normalized,
      ...(info.Time === undefined ? {} : { time: info.Time }),
      ...(go === undefined ? {} : { go }),
      requires,
    };

    const rawBody = new TextEncoder().encode(
      JSON.stringify({
        info,
        mod: modText ?? null,
        metadata,
      }),
    );
    const record: ProviderRecord<GolangModuleVersionMetadata> = {
      key: canonical,
      endpoint: infoResponse.url,
      ...(header(infoResponse, 'etag') === undefined
        ? {}
        : { etag: header(infoResponse, 'etag') }),
      body: metadata,
      rawBody,
      retrievedAt: this.clock.now(),
    };
    this.#infoRecords.set(record.key, record);
    return record;
  }
}
