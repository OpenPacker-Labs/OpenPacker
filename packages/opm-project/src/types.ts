import type { LifecycleState, PolicyInput } from '@openpacker/contracts';
import type { SourceKind, TrustTier } from '@openpacker/policy';

export type ArchiveFormat = 'tar' | 'tar+gzip' | 'zip';
export type { SourceKind, TrustTier };

export interface PackageRequirement {
  /** Local alias used by opm list / remove / opmx */
  alias: string;
  /** Base or exact PURL (version may be in `version` or embedded) */
  purl: string;
  /** Version or range when not encoded in purl */
  version?: string;
  /** Optional local/file/https artifact source */
  source?: string;
  /** Optional bin overrides (name → relative path) */
  bins?: readonly BinDeclaration[];
  /**
   * What kind of dependency this is.
   *
   * Absent means runtime, so every existing manifest keeps its meaning. It
   * exists because every native manifest separates production from development
   * dependencies, and a projection with nowhere to read that from would have to
   * guess — putting test tooling into what ships.
   */
  scope?: RequirementScope;
}

export interface RegistrySource {
  /** Source id, matching its key. */
  id: string;
  /** Base URL of a PREX registry, or an adapter-defined locator. */
  url: string;
  /**
   * Purl types this source answers for by default, so a project can say "our
   * npm packages come from the mirror" without repeating it per requirement.
   * Empty means the source is available but never chosen automatically.
   */
  defaultFor?: readonly string[];
}

export interface PackProviderSource {
  /** Local provider manifest path, resolved from the project root. */
  manifest: string;
  /** PURL types that select this provider when --provider is omitted. */
  defaultFor?: readonly string[];
  /** Names the provider may receive when the host grants values explicitly. */
  allowEnvironment?: readonly string[];
}

export type RequirementScope =
  | 'runtime'
  | 'development'
  | 'optional'
  | 'peer'
  | 'build';

/**
 * How far opm projects its decisions into the ecosystem's own project files.
 *
 * Levels are cumulative: `lock` implies `manifest`, `layout` implies both.
 */
export type NativeProjectionLevel = 'off' | 'manifest' | 'lock' | 'layout';

export interface BinDeclaration {
  name: string;
  path: string;
  /**
   * What runs this entry point.
   *
   * npm ships a script file that Node executes, which is why this was implicit
   * for so long. Other ecosystems do not: a Python console script is a module
   * and a function to call, and a .NET tool is a managed assembly. Naming the
   * interpreter is what lets one runner serve all of them instead of silently
   * finding nothing outside npm.
   *
   * Absent means Node, so every existing lockfile keeps its meaning.
   */
  interpreter?: 'node' | 'python' | 'dotnet';
  /** For Python console scripts: the `module:callable` to invoke. */
  entry?: string;
}

export interface OpmManifest {
  project: {
    name: string;
    ecosystems: readonly string[];
  };
  packages: Record<string, PackageRequirement>;
  /**
   * Named package sources this project may read from, keyed by source id.
   *
   * A source is not an ecosystem — one PREX registry can serve npm, PyPI and
   * NuGet at once — so it is configured separately from `project.ecosystems`
   * and selected per purl type by `defaultFor`.
   */
  registries?: Record<string, RegistrySource>;
  /** Local delegated pack providers keyed by their manifest id. */
  packProviders?: Record<string, PackProviderSource>;
  options: {
    offline: boolean;
    layout: 'opm';
    /**
     * Whether opm maintains the ecosystem's own project files. Defaults to
     * `manifest`: a project that has a package.json expects its dependencies
     * to be in it, and leaving them out is what made opm and npm disagree.
     */
    nativeProjection?: NativeProjectionLevel;
  };
  /**
   * Committed supply-chain / PREX policy profile (PolicyInput subset).
   * Digested when evaluated; no secret expansion in registry URLs.
   */
  policy?: PolicyInput;
}

export interface LockPackage {
  alias: string;
  purl: string;
  version: string;
  digest: string;
  size: number;
  format: ArchiveFormat;
  mediaType: string;
  source: string;
  storeKey: string;
  bins: readonly BinDeclaration[];
  reason: 'direct' | 'transitive';
  ecosystem: string;
  /** Lock aliases this package requires in the selected closure. */
  dependencies?: readonly string[];
  /** Captured trust tier for no-downgrade on upgrade. */
  trustLevel?: TrustTier;
  /** Registry-reported publish time when captured. */
  publishedAt?: string;
  /** Registry Definition registryId when known. */
  registryId?: string;
  /** How the package source was obtained. */
  sourceKind?: SourceKind;
  /** Registry lifecycle state captured when the lock was resolved. */
  lifecycle?: LifecycleState;
  /**
   * The ecosystem's own integrity value over the same archive bytes.
   *
   * PREX pins with sha256, but every native lockfile pins with its own scheme
   * — npm SRI, NuGet base64 sha512, Cargo sha256 hex. It is captured at
   * resolve time because the archive is not kept after extraction, and a
   * native lockfile written with an invented value is worse than none.
   */
  nativeIntegrity?: NativeIntegrity;
}

export interface NativeIntegrity {
  /** `sha256`, `sha512`. */
  algorithm: string;
  value: string;
  /** `hex`, `base64`, `sri`. */
  encoding: string;
}

export interface OpmLockfile {
  schemaVersion: 1;
  generatedBy: 'opm';
  /** Digest of the exact manifest and policy that produced this lock. */
  manifestDigest?: string;
  packages: Record<string, LockPackage>;
}

export interface InstalledPackageRecord {
  alias: string;
  purl: string;
  digest: string;
  storePath: string;
  bins: readonly {
    name: string;
    path: string;
    shim: string;
    target: string;
  }[];
  installedAt: string;
  /**
   * Whether lifecycle scripts ran for this package during install.
   * Absent means not recorded (pre-sandbox installs).
   */
  lifecycleScriptsExecuted?: boolean;
  /** Sandbox backend id when install-time execution was sandboxed. */
  sandboxBackend?: string;
  /** Whether a jail was enforced for install-time execution. */
  sandboxEnforced?: boolean;
}

export interface ProjectState {
  schemaVersion: 1;
  packages: Record<string, InstalledPackageRecord>;
}

export interface CatalogPackage {
  purl: string;
  version: string;
  digest: string;
  size: number;
  format: ArchiveFormat;
  mediaType: string;
  /** Relative to catalog file or absolute / file: URI */
  source: string;
  bins?: readonly BinDeclaration[];
}

export interface OpmCatalog {
  schemaVersion: 1;
  packages: Record<string, CatalogPackage>;
}

export interface ParsedPackageSpec {
  alias: string;
  purl: string;
  version?: string;
  ecosystem?: string;
  source?: string;
}

export class OpmError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'OpmError';
    this.code = code;
  }
}
