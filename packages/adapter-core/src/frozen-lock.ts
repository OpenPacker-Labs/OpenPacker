/**
 * What a frozen install reads from a native lock.
 *
 * A frozen install installs exactly what a committed lock says and resolves
 * nothing. The ecosystem adapter reads its own lock (the format, the flags, the
 * placement are its knowledge) and answers in these terms; the host fetches,
 * verifies, applies policy and writes the layout without knowing the format.
 */

import type { NativeTarget } from './host-target.js';
import type { NativeLayoutWorkspace } from './layout-workspace.js';
import type { WorkspaceMember } from './workspace/members.js';

/** Which kinds of dependency an install leaves out. */
export type FrozenOmit = 'dev' | 'optional' | 'peer';

/**
 * Which part of a workspace a frozen install installs, as `npm ci` reads
 * `--workspace`, `--include-workspace-root` and `--workspaces=false`.
 *
 * - `all`: the root, every member and everything they need.
 * - `members`: only these members (directories relative to the root) and what
 *   they need; the root's own dependencies too when `includeRoot` is set.
 * - `root`: the root's own dependencies, no member and no link to one.
 */
export type FrozenWorkspaceScope =
  | { kind: 'all' }
  | {
      kind: 'members';
      dirs: readonly string[];
      includeRoot: boolean;
    }
  | { kind: 'root' };

/** The workspace as the project's own files declare it, and the part to install. */
export interface FrozenWorkspaceInput {
  /**
   * The members found on disk by the host's discovery (root included when it
   * has a manifest); empty when the project declares no workspaces. Discovery
   * reads every member's `package.json` strictly, so it is asked for only by a
   * project that has a workspace to compare: the adapter calls it when the lock
   * lists members or `package.json` declares `workspaces`, and never for a
   * project with neither, which is installed as it always was.
   */
  disk(): Promise<readonly WorkspaceMember[]>;
  scope: FrozenWorkspaceScope;
}

export interface FrozenLockOptions {
  /** The machine the install is for, in the ecosystem's own vocabulary. */
  target: NativeTarget;
  /**
   * Every machine whose packages are installed, `target` among them: a package
   * is installed when it runs on any one of them (pnpm's
   * `supportedArchitectures`). Absent, `target` alone.
   */
  targets?: readonly NativeTarget[];
  /**
   * The registry a package that has no URL in its lock is fetched from (a pnpm
   * lock records an integrity and nothing else for one). The public registry
   * when absent.
   */
  registry?: string;
  omit: ReadonlySet<FrozenOmit>;
  /**
   * Set by a host that discovered the project's workspace. A format that
   * declares a `workspaceTool` is given it, so a lock that lists members is
   * judged against the members on disk.
   */
  workspace?: FrozenWorkspaceInput;
}

/**
 * Where the bytes come from, as far as the lock can tell.
 *
 * `registry` is the one kind the default policy lets a transitive dependency
 * have. The others are named so that policy can refuse them by name.
 */
export type FrozenSourceKind = 'registry' | 'tarball' | 'git' | 'path';

export interface FrozenLockPackage {
  /**
   * Where the lock puts this package: unique in the lock, and the key a layout
   * is planned from (npm: `node_modules/a/node_modules/b`).
   */
  path: string;
  /** The name the package lives under; an alias for an aliased dependency. */
  name: string;
  /** The package's own name. */
  packageName: string;
  version: string;
  purl: string;
  exactPurl: string;
  /** Where the lock says the archive is. */
  source: string;
  sourceKind: FrozenSourceKind;
  /** The lock's integrity value, as it spells it. */
  integrity: string;
  /** Named by the project's own manifest. */
  direct: boolean;
  scope: 'runtime' | 'development' | 'optional' | 'peer';
  /** Declares an install script. Nothing here runs it. */
  hasInstallScript: boolean;
  /**
   * The lock does not say whether the package declares an install script (a
   * pnpm lock keeps that elsewhere), so the host reads it from the archive it
   * has extracted and `hasInstallScript` is only a default.
   */
  scriptsFromArchive?: true;
  /**
   * What the lock calls this package when several places hold it (a pnpm
   * snapshot key, `react-dom@18.2.0(react@18.2.0)`): one id may have several
   * paths, and two ids may share an archive.
   */
  instance?: string;
  /** The registry's deprecation message, when the lock carries one. */
  deprecated?: string;
  /**
   * Set when the lock says this release has been withdrawn. npm's lock carries
   * no such flag; a format that does fills this, and policy then denies the
   * package unless the project allows that kind of release.
   */
  withdrawn?: 'yanked' | 'quarantined' | 'revoked' | 'delisted';
}

export interface FrozenLockSkip {
  path: string;
  name: string;
  version: string;
  /**
   * Why, in one word: left out by the options (`omitted`), for another
   * platform (`platform`), needed only by something left out (`orphaned`),
   * shipped inside its parent's archive (`bundled`), or outside the
   * workspaces the install was asked for (`workspace`).
   */
  kind: 'omitted' | 'platform' | 'orphaned' | 'bundled' | 'workspace';
  /** The same, in words. */
  reason: string;
}

/** Something the lock holds that this install cannot honour. */
export interface FrozenLockRefusal {
  path: string;
  reason: string;
}

/**
 * What this ecosystem's own extractor accepts beyond opm's default, which a
 * frozen install must too if it is to install what the native tool would.
 */
export interface FrozenExtraction {
  /**
   * npm's tar extraction writes `package/./dist/index.js` as
   * `package/dist/index.js` and a file listed twice once; published packages
   * carry both spellings.
   */
  acceptRedundantEntries: boolean;
}

/** The workspace part of what a frozen install does. */
export interface FrozenLockWorkspace {
  /**
   * Every member directory the lock holds, root-relative. A frozen install
   * clears each one's `node_modules` before it writes, as `npm ci` does,
   * whichever members it then installs.
   */
  memberDirs: readonly string[];
  /** What the layout links and shims: the members this install installs. */
  layout: NativeLayoutWorkspace;
}

export interface FrozenLock {
  /** The lock file read, absolute. */
  lockPath: string;
  /** sha256 over the lock's bytes, hex. */
  lockDigest: string;
  lockfileVersion: number;
  /** How its archives are to be read. */
  extraction: FrozenExtraction;
  /** What to install, parents before the packages nested in them. */
  packages: FrozenLockPackage[];
  /** What the lock holds that this host and these options leave out. */
  skipped: FrozenLockSkip[];
  /** Why the lock cannot be installed as it stands; any entry stops the install. */
  refused: FrozenLockRefusal[];
  /** Present when the lock is a workspace's. */
  workspace?: FrozenLockWorkspace;
}
