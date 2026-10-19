/**
 * What a frozen install would do, without doing any of it (ADR 0055 §23).
 *
 * Everything `installFrozen` does before the first byte is fetched: the lock is
 * read and held to the project, what it holds that cannot be installed is
 * refused, every package is judged against the policy. Nothing is fetched,
 * written or removed, so a plan that passes can fail later only on the
 * network, the store or the disk.
 */

<<<<<<< ours
import type {
  FrozenLockPeers,
  FrozenLockSkip,
  NativeTarget,
} from '@openpacker/adapter-core';
=======
import type { FrozenLockSkip, NativeTarget } from '@openpacker/adapter-core';
>>>>>>> theirs
import {
  now,
  prepareFrozen,
  type FrozenInstallInput,
} from './frozen-prepare.js';
import { integrityKey } from './integrity.js';

export interface FrozenPlan {
  ecosystem: string;
  lockPath: string;
  /** sha256 over the lock file's bytes. */
  lockDigest: string;
  /** Packages the lock resolves: the places that hold one share an instance. */
  instances: number;
  /** Directories under a `node_modules` the install would write. */
  places: number;
  /** Archives to fetch or find in the store: places and instances can share one. */
  archives: number;
<<<<<<< ours
=======
  /** Packages the lock patches (one per archive and patch), and the patches. */
  patched: { packages: number; patches: number };
>>>>>>> theirs
  /** For a workspace lock: the members, the ones installed and the links made. */
  workspace?: { members: number; installed: number; linked: number };
  skipped: readonly FrozenLockSkip[];
  targets?: readonly NativeTarget[];
<<<<<<< ours
  /** Present when the places would not keep every shared peer to one copy of it. */
  peers?: FrozenLockPeers;
=======
>>>>>>> theirs
  milliseconds: number;
}

export async function planFrozen(
  input: FrozenInstallInput,
): Promise<FrozenPlan> {
  const { started, lock, claims, ecosystem } = await prepareFrozen(input);
  const instances = new Set(
    lock.packages.map((pkg) => pkg.instance ?? pkg.path),
  );
  const archives = new Set(
    lock.packages.map((pkg) => integrityKey(claims.get(pkg.path)!)),
  );
<<<<<<< ours
=======
  const patched = lock.packages.filter((pkg) => pkg.patch !== undefined);
>>>>>>> theirs
  return {
    ecosystem,
    lockPath: lock.lockPath,
    lockDigest: lock.lockDigest,
    instances: instances.size,
    places: lock.packages.length,
    archives: archives.size,
<<<<<<< ours
=======
    patched: {
      packages: new Set(
        patched.map(
          (pkg) =>
            `${integrityKey(claims.get(pkg.path)!)}\0${pkg.patch!.digest}`,
        ),
      ).size,
      patches: new Set(patched.map((pkg) => pkg.patch!.key)).size,
    },
>>>>>>> theirs
    ...(lock.workspace !== undefined && {
      workspace: {
        members: lock.workspace.memberDirs.length,
        installed: lock.workspace.layout.members.length,
        linked: lock.workspace.layout.links.length,
      },
    }),
    skipped: lock.skipped,
    ...(lock.targets !== undefined && { targets: lock.targets }),
<<<<<<< ours
    ...(lock.peers !== undefined && { peers: lock.peers }),
=======
>>>>>>> theirs
    milliseconds: now() - started,
  };
}
