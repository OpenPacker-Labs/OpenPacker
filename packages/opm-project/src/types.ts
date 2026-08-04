import type { PolicyInput } from '@openpacker/contracts';
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
}

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
  options: {
    offline: boolean;
    layout: 'opm';
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
  /** Captured trust tier for no-downgrade on upgrade. */
  trustLevel?: TrustTier;
  /** Registry-reported publish time when captured. */
  publishedAt?: string;
  /** Registry Definition registryId when known. */
  registryId?: string;
  /** How the package source was obtained. */
  sourceKind?: SourceKind;
}

export interface OpmLockfile {
  schemaVersion: 1;
  generatedBy: 'opm';
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
