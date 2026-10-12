/**
 * The model of a `pnpm-lock.yaml` (lockfileVersion '9.0), as pnpm 9 and 10 write
 * it: what a lock says, in the lock's own terms, with nothing resolved,
 * fetched or decided. ADR 0052 says what is modelled and what is refused.
 *
 * Everything keyed by a name or a path is an array sorted by that key in code
 * unit order, or a `Map` built in that order, so the same lock reads to the same
 * value whatever order the file listed things in. A list derived from a model
 * (the summary's, the exotic sources, the orphans) sorts itself, so it does not
 * depend on the order the model was built in; the ones that walk the model
 * (links, problems) list in the model's order, "lock order".
 */

import type { DepPath } from './dep-path.js';
import type { PnpmRef } from './ref.js';
import type { SourceKind } from './source.js';

export type { DepPath } from './dep-path.js';
export type { DepRef, LinkRef, PnpmRef } from './ref.js';
export type { SourceKind } from './source.js';

/** The three lists an importer keeps its direct dependencies in. */
export type ImporterField =
  | 'dependencies'
  | 'devDependencies'
  | 'optionalDependencies';

/** What the lock records under `settings`; each is absent when pnpm omits its default. */
export interface PnpmSettings {
  /** Peers nobody lists are installed (pnpm's default is true). */
  readonly autoInstallPeers?: boolean;
  /** `link:` dependencies are left out of the importers (pnpm's default is false). */
  readonly excludeLinksFromLockfile?: boolean;
  /** Where a list of peers becomes a hash (1000 when absent). */
  readonly peersSuffixMaxLength?: number;
  /** Workspace packages may be installed as copies (false when absent). */
  readonly injectWorkspacePackages?: boolean;
}

/** One direct dependency of an importer: what package.json asked for, and what it got. */
export interface PnpmImporterDependency {
  /** The dependency's name in package.json, which is the directory it is installed under. */
  readonly name: string;
  /** The specifier as package.json wrote it: `^18.0.0`, `workspace:*`, `npm:a@1`, `catalog:`. */
  readonly specifier: string;
  readonly ref: PnpmRef;
}

/** `dependenciesMeta` for one dependency, as package.json wrote it. */
export interface PnpmDependencyMeta {
  readonly injected?: boolean;
  readonly node?: string;
  readonly patch?: string;
}

/** A workspace project: `.` for the root, or its directory relative to it. */
export interface PnpmImporter {
  readonly id: string;
  readonly dependencies: readonly PnpmImporterDependency[];
  readonly devDependencies: readonly PnpmImporterDependency[];
  readonly optionalDependencies: readonly PnpmImporterDependency[];
  readonly dependenciesMeta: ReadonlyMap<string, PnpmDependencyMeta>;
  /** `publishConfig.directory`, relative to the project. */
  readonly publishDirectory?: string;
}

/** One platform a runtime build is for. */
export interface PnpmRuntimeTarget {
  readonly os: string;
  readonly cpu: string;
  readonly libc?: string;
}

/** A runtime archive for some platforms (`node@runtime:`). */
export interface PnpmRuntimeVariant {
  readonly targets: readonly PnpmRuntimeTarget[];
  readonly archive: 'tarball' | 'zip';
  readonly url: string;
  readonly integrity: string;
  readonly bin: string;
  readonly prefix?: string;
}

/** Where a package's bytes come from, as `resolution` says. */
export type PnpmResolution =
  /** `{integrity}`: the registry's tarball, whose URL is derived from the name and version. */
  | { readonly kind: 'integrity'; readonly integrity: string }
  /** `{tarball, integrity?}`: an archive at a URL (a registry with an unusual layout, a git host's, a `file:` archive). */
  | {
      readonly kind: 'tarball';
      readonly tarball: string;
      readonly integrity?: string;
      readonly path?: string;
    }
  /** `{type: directory, directory}`: a directory on disk, relative to the project. */
  | { readonly kind: 'directory'; readonly directory: string }
  /** `{type: git, repo, commit}`. */
  | {
      readonly kind: 'git';
      readonly repo: string;
      readonly commit: string;
      readonly path?: string;
    }
  /** `{type: variations, variants}`: a runtime with one archive per platform. */
  | {
      readonly kind: 'variations';
      readonly variants: readonly PnpmRuntimeVariant[];
    };

/** An entry of `packages`: what one `name@version` is, whatever peers it was resolved against. */
export interface PnpmPackage {
  /** The key as written, `name@version`. */
  readonly key: string;
  readonly name: string;
  readonly version: string;
  readonly source: SourceKind;
  readonly resolution: PnpmResolution;
  /** `name`, written for packages whose key does not say it (a git or tarball source). */
  readonly manifestName?: string;
  /** `version`, written for packages whose key is not a registry version. */
  readonly manifestVersion?: string;
  readonly engines: ReadonlyMap<string, string>;
  /** Absent when the package does not restrict the CPU; the lists are npm's, with `!` negations. */
  readonly cpu?: readonly string[];
  readonly os?: readonly string[];
  readonly libc?: readonly string[];
  readonly hasBin: boolean;
  readonly deprecated?: string;
  readonly peerDependencies: ReadonlyMap<string, string>;
  readonly peerDependenciesMeta: ReadonlyMap<
    string,
    { readonly optional: boolean }
  >;
  /** The names bundled in the package, or `true` for all of `dependencies`. */
  readonly bundledDependencies?: boolean | readonly string[];
}

/** One dependency edge of a snapshot. */
export interface PnpmSnapshotDependency {
  readonly name: string;
  readonly ref: PnpmRef;
}

/** An entry of `snapshots`: a package resolved against one set of peers. */
export interface PnpmSnapshot {
  /** The key as written, `name@version(suffix)`. */
  readonly key: string;
  readonly path: DepPath;
  readonly dependencies: readonly PnpmSnapshotDependency[];
  readonly optionalDependencies: readonly PnpmSnapshotDependency[];
  readonly transitivePeerDependencies: readonly string[];
  /** Reachable only through optional dependencies. */
  readonly optional: boolean;
  readonly id?: string;
  readonly patched?: boolean;
}

/** `catalogs.<name>.<dependency>`: what the catalog asked for and what it resolved to. */
export interface PnpmCatalogEntry {
  readonly specifier: string;
  readonly ref: PnpmRef;
}

/** `patchedDependencies.<name@version>`. */
export interface PnpmPatch {
  readonly hash: string;
  /** The patch file, relative to the workspace root. */
  readonly path: string;
}

export interface PnpmLock {
  readonly lockfileVersion: '9.0';
  readonly settings: PnpmSettings;
  /** `overrides`: selector to replacement, verbatim. */
  readonly overrides: ReadonlyMap<string, string>;
  readonly catalogs: ReadonlyMap<string, ReadonlyMap<string, PnpmCatalogEntry>>;
  readonly patchedDependencies: ReadonlyMap<string, PnpmPatch>;
  readonly packageExtensionsChecksum?: string;
  readonly pnpmfileChecksum?: string;
  readonly ignoredOptionalDependencies: readonly string[];
  /** `time`: when each version was published, for time-based resolution. */
  readonly time: ReadonlyMap<string, string>;
  readonly importers: readonly PnpmImporter[];
  readonly packages: readonly PnpmPackage[];
  readonly snapshots: readonly PnpmSnapshot[];
}
