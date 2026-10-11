/**
 * What a frozen install reads from a native lock.
 *
 * A frozen install installs exactly what a committed lock says and resolves
 * nothing. The ecosystem adapter reads its own lock (the format, the flags, the
 * placement are its knowledge) and answers in these terms; the host fetches,
 * verifies, applies policy and writes the layout without knowing the format.
 */

import type { NativeTarget } from './host-target.js';

/** Which kinds of dependency an install leaves out. */
export type FrozenOmit = 'dev' | 'optional' | 'peer';

export interface FrozenLockOptions {
  /** The machine the install is for, in the ecosystem's own vocabulary. */
  target: NativeTarget;
  omit: ReadonlySet<FrozenOmit>;
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
  /** Why this host does not install it. */
  reason: string;
}

/** Something the lock holds that this install cannot honour. */
export interface FrozenLockRefusal {
  path: string;
  reason: string;
}

export interface FrozenLock {
  /** The lock file read, absolute. */
  lockPath: string;
  /** sha256 over the lock's bytes, hex. */
  lockDigest: string;
  lockfileVersion: number;
  /** What to install, parents before the packages nested in them. */
  packages: FrozenLockPackage[];
  /** What the lock holds that this host and these options leave out. */
  skipped: FrozenLockSkip[];
  /** Why the lock cannot be installed as it stands; any entry stops the install. */
  refused: FrozenLockRefusal[];
}
