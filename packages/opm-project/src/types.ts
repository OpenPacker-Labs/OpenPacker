export type ArchiveFormat = 'tar' | 'tar+gzip' | 'zip';

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
