import { canonicalDigest, formatDigest, sha256 } from '@openpacker/canonical';
import { readPackageLock, type LockEntry } from './lock-tree.js';
import { isNpmAlias, parseNpmAlias } from './alias.js';
import { aliasRequirement } from './alias-requirement.js';
import {
  identityFromPurl,
  isTimestamp,
  npmName,
  npmNamespace,
  sriSha256,
} from './npm-identity.js';
import { npmRangeVers } from './range-vers.js';
import { unsafeNameProblem } from './layout-plan.js';
import { asBundled, bundledDependencyNames } from './bundled.js';
import { npmTargetPredicate } from './platform.js';
import {
  compareNpmVersions,
  npmSatisfies,
  parseNpmRange,
  parseNpmVersion,
} from './npm-range.js';
import type {
  ArtifactDescriptor,
  PackageIdentity,
  PackageInstance,
  Requirement,
  SemanticLoss,
  SourceSnapshot,
  VersionConstraint,
  JsonValue,
} from '@openpacker/contracts';
import {
  assertPackageIdentityMatchesRequest,
  compareCodePoints,
  formatPurl,
  header,
  json,
  packageNodeId,
  parsePurl,
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
  /**
   * Names of dependencies that ship inside this package's own archive. The
   * abbreviated packument carries them as an array; `true` (every dependency)
   * and the `bundledDependencies` spelling are read from the full document.
   */
  bundleDependencies?: string[] | boolean;
  bundledDependencies?: string[] | boolean;
  engines?: Record<string, string>;
  os?: string[];
  cpu?: string[];
  /**
   * The C library a binary package was built for. The abbreviated packument
   * omits it (the per-version document and the full packument carry it), so it
   * is completed from the version document where it can matter.
   */
  libc?: string[];
  /** The abbreviated packument's stand-in for `scripts`, which it omits. */
  hasInstallScript?: boolean;
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
  /** When the registry last changed this document (any version, tag or flag). */
  modified?: string;
  etag?: string;
  [key: string]: unknown;
}

export interface NpmPackageLockV3 {
  name?: string;
  version?: string;
  lockfileVersion: 2 | 3;
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

export { npmRangeVers };
export {
  classifyDependencySpec,
  type NpmDependencySpecKind,
} from './dependency-spec.js';
import { classifyDependencySpec } from './dependency-spec.js';

function npmPackagePurl(name: string): string {
  const coordinate = new NpmCodec().parseNativeCoordinate(name);
  return formatPurl({
    type: 'npm',
    namespace: npmNamespace(coordinate.namespace),
    name: coordinate.name,
    qualifiers: {},
  });
}

function npmRequirement(
  dependerNodeId: string,
  name: string,
  range: string,
  kind: Requirement['kind'],
  optional: boolean,
  endpoint: string,
  path: string,
  owner: string,
  enforced: boolean,
  followed: boolean = enforced,
): Requirement {
  const alias = isNpmAlias(range) ? parseNpmAlias(range) : undefined;
  // The key an alias is written under becomes a directory, and it is chosen by
  // whoever published the package: it is held to the rule a package name is.
  const aliasProblem =
    alias === undefined
      ? undefined
      : 'problem' in alias
        ? alias.problem
        : unsafeNameProblem(name);
  const specKind = classifyDependencySpec(range);
  const dependencyField = path.slice(1).split('/')[0]!;
  if (
    alias !== undefined &&
    'target' in alias &&
    followed &&
    aliasProblem === undefined
  )
    return aliasRequirement({
      dependerNodeId,
      installName: name,
      aliasSpec: range,
      alias,
      kind,
      optional,
      endpoint,
      path,
      dependencyField,
      purl: npmPackagePurl(alias.target),
      parsed:
        alias.kind === 'range'
          ? new NpmCodec().parseNativeRange(alias.spec)
          : undefined,
    });
  if (specKind !== 'range') {
    // An install walks into `dependencies` and required peers. Reading
    // "github:user/repo" as "any version of the registry package with that
    // name" would be a dependency-confusion door, so those fail here, by name.
    // The fields an install does not walk (development, optional peers) are
    // kept as what they say, with no version constraint attached, so inspecting
    // a package never depends on its dev-time tooling.
    if (enforced)
      throw new ProviderError(
        'UNSUPPORTED_DEPENDENCY_SPEC',
        `${owner} depends on ${name} as "${range}", a ${specKind} specifier ` +
          `that is not a registry version range` +
          (aliasProblem === undefined ? '' : ` (${aliasProblem})`),
      );
    return {
      id: `${dependerNodeId}:${kind}:${name}`,
      dependerNodeId,
      expression: { type: 'package', purl: npmPackagePurl(name) },
      kind,
      optional: true,
      source: sourceRef('npm', endpoint),
      authority: 'native',
      raw: { path, range },
      nativeSemantics: {
        version: 'npm-v1',
        data: { dependencyField, range, specKind },
      },
      semanticLoss: [
        semanticLoss(
          'npm',
          'NPM_DEPENDENCY_SPEC_NOT_A_RANGE',
          path,
          `The ${specKind} specifier "${range}" is not a registry version range`,
          'The package is named without a version constraint and the specifier is retained verbatim',
          'info',
        ),
      ],
    };
  }
  const parsed = new NpmCodec().parseNativeRange(range);
  const vers = parsed.vers ?? npmRangeVers(parsed.ast);
  return {
    id: `${dependerNodeId}:${kind}:${name}`,
    dependerNodeId,
    expression: {
      type: 'package',
      purl: npmPackagePurl(name),
      ...(!(vers === undefined) && { vers }),
    },
    kind,
    optional,
    source: sourceRef('npm', endpoint),
    authority: 'native',
    raw: { path, range },
    nativeSemantics: {
      version: 'npm-v1',
      data: { dependencyField, range },
    },
    semanticLoss: parsed.semanticLoss.map((loss) =>
      vers === undefined || parsed.vers !== undefined
        ? loss
        : {
            ...loss,
            representedMeaning:
              'A comparison form that is a superset of the range: it also admits prereleases npm would exclude. The native range is re-checked after the solve',
          },
    ),
  };
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
    return parseNpmVersion(value);
  }

  compareNativeVersions(left: string, right: string): number {
    return compareNpmVersions(left, right);
  }

  parseNativeRange(value: string): ParsedRange {
    return parseNpmRange(value);
  }

  toVers(value: string): VersionConstraint {
    return rangeToConstraint(this.parseNativeRange(value));
  }

  satisfies(version: string, range: string | ParsedRange): boolean {
    return npmSatisfies(version, range);
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
    const losses: SemanticLoss[] = [];
    const owner = `${metadata.name}@${metadata.version}`;
    const bundled = bundledDependencyNames(metadata);
    for (const [dependencies, kind, optionalByKind, field] of fields) {
      for (const [name, range] of Object.entries(dependencies ?? {}).sort(
        ([left], [right]) => compareCodePoints(left, right),
      )) {
        const optional =
          optionalByKind ||
          (field === 'peerDependencies' &&
            metadata.peerDependenciesMeta?.[name]?.optional === true);
        // What an install walks into: runtime dependencies and required peers.
        // A dependency this package ships inside its own archive is not walked
        // into, whatever it says, because it is never resolved.
        const bundledHere =
          (field === 'dependencies' || field === 'optionalDependencies') &&
          bundled.has(name);
        const enforced =
          !bundledHere &&
          (field === 'dependencies' ||
            (field === 'peerDependencies' && !optional));
        // Optional dependencies are walked where they run, so an alias in one
        // (the per-platform builds of a native package) is read like any other.
        const followed =
          !bundledHere && (enforced || field === 'optionalDependencies');
        try {
          const requirement = npmRequirement(
            nodeId,
            name,
            range,
            kind,
            optional,
            provenance.endpoint,
            `/${field}/${name}`,
            owner,
            enforced,
            followed,
          );
          requirements.push(
            bundledHere
              ? asBundled(requirement, `/${field}/${name}`)
              : requirement,
          );
        } catch (error) {
          if (enforced) throw error;
          // A dev-time or optional entry this codec cannot read must not stop
          // the package from being inspected. It is recorded, not dropped.
          losses.push(
            semanticLoss(
              'npm',
              'NPM_DEPENDENCY_NOT_REPRESENTABLE',
              `/${field}/${name}`,
              `The ${field} entry "${name}": "${range}" cannot be represented: ${error instanceof Error ? error.message : String(error)}`,
              undefined,
              'info',
            ),
          );
        }
      }
    }
    if (
      (metadata.scripts && Object.keys(metadata.scripts).length > 0) ||
      metadata.hasInstallScript === true
    ) {
      losses.push(
        semanticLoss(
          'npm',
          'NPM_LIFECYCLE_SCRIPTS_NOT_EXECUTED',
          '/scripts',
          'Lifecycle scripts are preserved as inert metadata and never executed',
        ),
      );
    }
    const targetPredicate = npmTargetPredicate(
      metadata.os,
      metadata.cpu,
      metadata.libc,
    );
    if (metadata.os || metadata.cpu || metadata.libc) {
      losses.push(
        semanticLoss(
          'npm',
          'NPM_PACKAGE_TARGET_PREDICATE_ARTIFACT_ONLY',
          '/os',
          'npm os, cpu and libc constraints apply to the package as a whole',
          'The exact predicate is preserved and applied to artifacts, but PackageInstance has no package-level predicate',
          'error',
        ),
      );
    }
    if (metadata.engines)
      // npm treats `engines` as advice (EBADENGINE is a warning unless
      // engine-strict is set), and the range is kept verbatim in
      // nativeSemantics.data.engines. Nothing about which packages are selected
      // or which bytes are installed depends on it, so this is information, not
      // a loss that should keep a package out. Declared `error`, it denied
      // every real package under the default policy, since almost all of them
      // say which Node they support.
      losses.push(
        semanticLoss(
          'npm',
          'NPM_ENGINE_RANGE_NATIVE_ONLY',
          '/engines',
          'npm engine compatibility uses npm range and advisory enforcement semantics',
          'The range is retained verbatim in nativeSemantics.data.engines and is not evaluated against the target',
          'info',
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
        ...(!(metadata.dist.tarball.split('/').at(-1) === undefined) && {
          fileName: metadata.dist.tarball.split('/').at(-1)!,
        }),
        nativeRole: 'package-archive',
        ...(!(targetPredicate === undefined) && { targetPredicate }),
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
        // SAFETY: The surrounding boundary establishes the asserted domain contract.
        data: {
          distTagsAreMutable: true,
          engines: metadata.engines ?? {},
          os: metadata.os ?? [],
          cpu: metadata.cpu ?? [],
          libc: metadata.libc ?? [],
          hasInstallScript: metadata.hasInstallScript === true,
          ...(!(targetPredicate === undefined) && { targetPredicate }),
          peerDependenciesMeta: metadata.peerDependenciesMeta ?? {},
          scripts: metadata.scripts ?? {},
          ...(!(metadata.dist?.integrity === undefined) && {
            distIntegrity: metadata.dist.integrity,
          }),
          ...(!(metadata.dist?.shasum === undefined) && {
            distShasum: metadata.dist.shasum,
          }),
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
    const tree = readPackageLock(lock);
    // One selection per exact PURL. npm repeats a package at every path it is
    // placed, so the same `name@version` is normal; what a capture records is
    // the selection, and where it was placed rides along in `native.paths`.
    const groups = new Map<string, LockEntry[]>();
    const coordinates = new Map<string, string>();
    for (const entry of tree.entries) {
      const coordinate = this.parseNativeCoordinate(entry.packageName);
      const exactPurl = this.canonicalizePurl(
        formatPurl({
          type: 'npm',
          namespace: npmNamespace(coordinate.namespace),
          name: coordinate.name,
          version: entry.version,
          qualifiers: {},
        }),
      );
      coordinates.set(exactPurl, `${entry.packageName}@${entry.version}`);
      groups.set(exactPurl, [...(groups.get(exactPurl) ?? []), entry]);
    }
    const packages = [...groups]
      .map(([exactPurl, placed]) => {
        const first = placed[0]!;
        for (const other of placed.slice(1)) assertSameSelection(first, other);
        const paths = placed.map((entry) => entry.path).sort();
        return {
          exactPurl,
          nativeCoordinate: coordinates.get(exactPurl)!,
          ...(!(first.resolved === undefined) && { resolved: first.resolved }),
          ...(!(first.integrity === undefined) && {
            artifactDigest: first.integrity,
          }),
          dependencies: {
            ...first.dependencies,
            ...first.optionalDependencies,
          },
          native: {
            path: paths[0]!,
            paths,
            dev: placed.every((entry) => entry.dev),
            optional: placed.every((entry) => entry.optional),
            ...(!(first.integrity === undefined) && {
              integrity: first.integrity,
            }),
          },
        };
      })
      .sort((left, right) =>
        compareCodePoints(left.exactPurl, right.exactPurl),
      );
    // Workspace members and links are the project's own code, not registry
    // selections. They are left out of the capture, and said so.
    const local = [
      ...tree.links.map((link) => ({ path: link.path, kind: 'link' })),
      ...tree.foreign.map((entry) => ({ path: entry.path, kind: 'member' })),
    ].sort((left, right) => compareCodePoints(left.path, right.path));
    return {
      format: 'package-lock.json',
      formatVersion: String(tree.lockfileVersion),
      packages,
      semanticLoss: local.map((entry) =>
        semanticLoss(
          'npm',
          'NPM_WORKSPACE_ENTRY_NOT_CAPTURED',
          `/packages/${entry.path}`,
          `${entry.path} is a workspace ${entry.kind}, the project's own code`,
          'Not captured as a registry selection',
        ),
      ),
      sourceDigest: formatDigest(provenance.metadataDigest),
    };
  }
}

/**
 * Two placements of one `name@version` are one selection only if the lock says
 * the same thing about both. Anything else is a lock that pins one package two
 * ways, and picking either would be a guess.
 */
function assertSameSelection(left: LockEntry, right: LockEntry): void {
  const differs = (what: string): never => {
    throw new ProviderError(
      'INVALID_LOCKFILE',
      `${left.packageName}@${left.version} is locked with a different ${what} at ${left.path} and at ${right.path}`,
    );
  };
  if (left.resolved !== right.resolved) differs('resolved URL');
  if (left.integrity !== right.integrity) differs('integrity');
  const declared = (entry: LockEntry) =>
    JSON.stringify([
      Object.entries(entry.dependencies).sort(),
      Object.entries(entry.optionalDependencies).sort(),
    ]);
  if (declared(left) !== declared(right)) differs('set of dependencies');
}

/**
 * What the registry establishes about when a version was published.
 *
 * The abbreviated packument carries no per-version times, and the full one is
 * large (`vite`: 39 MB, 4.6 MB gzipped; the 44 packages of vitest's closure:
 * 54 MB against 8.7 MB abbreviated), so the evidence comes in the cheapest form
 * that settles the question asked.
 */
export interface PublishTimeEvidence {
  /** The registry's recorded publish time of exactly this version. */
  publishedAt?: string;
  /**
   * No version of the package was published later than this: the registry last
   * changed the document then, and publishing a version changes it. Not the
   * publish time, and never presented as one.
   */
  publishedNoLaterThan?: string;
  source: 'packument-time' | 'packument-modified' | 'full-packument';
}

/** A response this big is a mirror misbehaving; the largest real one is 39 MB. */
const FULL_PACKUMENT_LIMIT = 96 * 1024 * 1024;

export class NpmRegistryProvider implements CatalogProvider {
  readonly providerId = 'npm-registry';
  readonly capabilities: ProviderCapabilities = {
    operations: ['identify', 'enumerate', 'inspect', 'artifact', 'snapshot'],
    purlTypes: ['npm'],
    qualifierSupport: 'complete',
    targetSpecificSemantics: true,
    offlineReplay: true,
    extensions: { 'openpacker.dev/packument': 'abbreviated-install-v1' },
  };
  readonly #records = new Map<string, ProviderRecord<NpmPackument>>();
  readonly #times = new Map<
    string,
    Promise<Record<string, string> | undefined>
  >();
  readonly #libc = new Map<
    string,
    Promise<{ libc?: string[]; reason: string }>
  >();

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

  /**
   * The exact version a dist-tag points at, or undefined when the package has
   * no such tag (or the tag names a version the document does not list).
   *
   * Read from the `dist-tags` the abbreviated packument already carries, so a
   * tag costs no request the walk was not going to make. A tag moves, so the
   * caller records the version, never the tag.
   */
  async resolveTag(
    basePurl: string,
    tag: string,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const packument = await this.packument(basePurl, signal);
    const version = packument.body['dist-tags']?.[tag];
    if (
      typeof version !== 'string' ||
      packument.body.versions[version] === undefined
    )
      return undefined;
    return this.codec.canonicalizePurl(
      `${this.codec.canonicalizePurl(basePurl)}@${version}`,
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
    const listed = record.body.versions[parsed.version];
    if (!listed)
      throw new ProviderError(
        'VERSION_NOT_FOUND',
        `${canonical} is absent from the packument`,
      );
    const { metadata, warnings } = await this.withLibc(listed, signal);
    const metadataDigest = await canonicalDigest(
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      JSON.parse(JSON.stringify(metadata)) as JsonValue,
    );
    const translated = await this.codec.translateMetadata(metadata, {
      providerId: this.providerId,
      endpoint: record.endpoint,
      retrievedAt: record.retrievedAt,
      evaluationTime: record.retrievedAt,
      ...(!(record.etag === undefined) && { etag: record.etag }),
      metadataDigest,
      rawMetadataRef: {
        type: 'provider-metadata',
        locator: `urn:openpacker:npm:${encodeURIComponent(metadata.name)}:${metadata.version}`,
        digest: metadataDigest,
        mediaType: 'application/json',
      },
    });
    assertPackageIdentityMatchesRequest(
      canonical,
      translated.instance.identity,
    );
    return { package: translated.instance, record, warnings };
  }

  /**
   * Publish-time evidence for one version, from the cheapest source that
   * settles what the caller needs.
   *
   * In order: the packument's own `time` if the registry supplies it in the
   * abbreviated document (no extra bytes). Then, if `settledBefore` is given,
   * the document's `modified` stamp: when the registry last changed the
   * document is an upper bound on every version's publish time, so a package
   * not touched since before `settledBefore` was published before it, with no
   * request at all. Otherwise the full packument's `time` for this version,
   * which is the only exact source the registry offers and the expensive one,
   * paid only for a package that changed recently. A package whose time cannot
   * be had yields `undefined`, and the policy then says it was not provided.
   */
  async publishTime(
    exactPurl: string,
    needed: { settledBefore?: string } = {},
    signal?: AbortSignal,
  ): Promise<PublishTimeEvidence | undefined> {
    const parsed = parsePurl(this.codec.canonicalizePurl(exactPurl));
    if (!parsed.version) return undefined;
    const base = formatPurl({ ...parsed, version: undefined });
    const record = await this.packument(base, signal);
    const listed = record.body.time?.[parsed.version];
    if (isTimestamp(listed))
      return { publishedAt: listed, source: 'packument-time' };
    const modified = record.body.modified;
    if (
      needed.settledBefore !== undefined &&
      isTimestamp(modified) &&
      Date.parse(modified) <= Date.parse(needed.settledBefore)
    )
      return { publishedNoLaterThan: modified, source: 'packument-modified' };
    let pending = this.#times.get(base);
    if (pending === undefined) {
      pending = this.fetchFullTimes(parsed, signal);
      this.#times.set(base, pending);
    }
    const times = await pending;
    const exact = times?.[parsed.version];
    return isTimestamp(exact)
      ? { publishedAt: exact, source: 'full-packument' }
      : undefined;
  }

  private async fetchFullTimes(
    parsed: ReturnType<typeof parsePurl>,
    signal?: AbortSignal,
  ): Promise<Record<string, string> | undefined> {
    try {
      const response = await this.transport.request({
        url: `${this.endpoint.replace(/\/$/, '')}/${encodeURIComponent(npmName(parsed.namespace, parsed.name))}`,
        signal,
        maximumBytes: FULL_PACKUMENT_LIMIT,
        headers: { accept: 'application/json' },
      });
      return json<{ time?: Record<string, string> }>(response).time;
    } catch (error) {
      if (signal?.aborted) throw error;
      return undefined;
    }
  }

  async fetchArtifactRecord(
    exactPurl: string,
    signal?: AbortSignal,
  ): Promise<ProviderRecord> {
    const inspection = await this.inspect(exactPurl, signal);
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
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
      ...(!(dist.tarball.split('/').at(-1) === undefined) && {
        fileName: dist.tarball.split('/').at(-1)!,
      }),
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
          ...(!(record.etag === undefined) && { etag: record.etag }),
          digest: formatDigest(await sha256(record.rawBody)),
        })),
    );
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
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
      ...(!(etag === undefined) && { etag }),
      records: recordDigests,
    };
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const rootDigest = await canonicalDigest(rootPayload as JsonValue);
    return {
      snapshotId: formatDigest(rootDigest),
      providerId: this.providerId,
      providerType: 'npm-registry',
      endpointIdentity: this.endpoint,
      retrievedAt,
      evaluationTime,
      revision,
      ...(!(etag === undefined) && { etag }),
      rootDigest,
      recordsDigest,
      evidenceRefs: [],
    };
  }

  /**
   * Add the `libc` the abbreviated packument leaves out.
   *
   * `@rolldown/binding-linux-x64-gnu` and `-musl` are the same `os`/`cpu` in
   * the abbreviated document and differ only in `libc`, so without it a
   * linux/x64 host would take both. The version document is a few KB and is
   * asked for only for a package that is restricted to linux and does not
   * already say. If it cannot be had the package is still inspected, with a
   * warning, and the predicate simply has no `libc` clause.
   */
  private async withLibc(
    metadata: NpmVersionMetadata,
    signal?: AbortSignal,
  ): Promise<{
    metadata: NpmVersionMetadata;
    warnings: { code: string; message: string }[];
  }> {
    if (metadata.libc !== undefined || !metadata.os?.includes('linux'))
      return { metadata, warnings: [] };
    const key = `${metadata.name}@${metadata.version}`;
    let pending = this.#libc.get(key);
    if (pending === undefined) {
      pending = this.fetchLibc(metadata, signal);
      this.#libc.set(key, pending);
    }
    const found = await pending;
    return found.libc === undefined
      ? {
          metadata,
          warnings: [
            {
              code: 'NPM_LIBC_NOT_CAPTURED',
              message: `The version document for ${key} did not supply libc: ${found.reason}`,
            },
          ],
        }
      : { metadata: { ...metadata, libc: found.libc }, warnings: [] };
  }

  private async fetchLibc(
    metadata: NpmVersionMetadata,
    signal?: AbortSignal,
  ): Promise<{ libc?: string[]; reason: string }> {
    try {
      const response = await this.transport.request({
        url: `${this.endpoint.replace(/\/$/, '')}/${encodeURIComponent(metadata.name)}/${encodeURIComponent(metadata.version)}`,
        signal,
        maximumBytes: 1024 * 1024,
        headers: { accept: 'application/json' },
      });
      const document = json<NpmVersionMetadata>(response);
      if (
        document.name !== metadata.name ||
        document.version !== metadata.version
      )
        return { reason: 'it describes a different package version' };
      return Array.isArray(document.libc)
        ? { libc: document.libc, reason: '' }
        : { libc: [], reason: '' };
    } catch (error) {
      if (signal?.aborted) throw error;
      return {
        reason: error instanceof Error ? error.message : String(error),
      };
    }
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
    const record: ProviderRecord<NpmPackument> = {
      key,
      endpoint: response.url,
      ...(!(header(response, 'etag') === undefined) && {
        etag: header(response, 'etag'),
      }),
      body: json<NpmPackument>(response),
      rawBody: response.body,
      retrievedAt: this.clock.now(),
    };
    this.#records.set(record.key, record);
    return record;
  }
}

export { NpmProjectFormat, npmPublishPaths } from './project.js';
export { npmPackageRuns, npmTargetPredicate } from './platform.js';
export {
  chainOfLockPath,
  findDuplicateJsonKey,
  parsePackageLockText,
  readPackageLock,
  resolveFromChain,
  MAXIMUM_LOCK_ENTRIES,
  type LockEntry,
  type LockForeignEntry,
  type LockLink,
  type LockRoot,
  type LockWorkspace,
  type PackageLockTree,
} from './lock-tree.js';
export type { LockMember, LockMemberLink } from './lock-workspace.js';

export * from './pnpm-lock/index.js';
