/**
 * A patched package's paths, held to what the system takes before anything is
 * fetched (ADR 0056 §13).
 *
 * The files of a patch are made in `.<key>.materialize-<uuid>/package/` below
 * the store, and a system call takes 4,095 bytes of path, the store's own
 * directories included. A patch is read without knowing where the store is, so
 * a path that passes every bound of its own (4,088 bytes, 127 segments, 255 a
 * name) can still be one the install cannot make. The plan and the install
 * know the project and the environment, which is enough to say how long the
 * directory can be at most: the shared store `OPM_STORE_HOME` names, or the
 * private one beside `node_modules`, whichever is longer. The install checks
 * again with the directory it really made, so a store that moved between the
 * two is still a refusal and never an `ENAMETOOLONG`.
 */

import { join } from 'node:path';
import {
  PACKAGE_ROOT,
  quote,
  wholePathProblem,
  type FrozenLockPackage,
  type ProjectFormat,
} from '@openpacker/adapter-core';
import { storeKeyFromDigest } from './paths.js';
import { sharedStoreRoot } from './shared-store-root.js';
import { OpmError } from './types.js';

const ZEROS = '0'.repeat(64);

/** The longest directory, in bytes, a patched package of `root`'s project is made in. */
export function patchedPackageDirectoryBytes(
  root: string,
  env: NodeJS.ProcessEnv,
): number {
  const key = `${storeKeyFromDigest(`sha256:${ZEROS}`)}-patch-${ZEROS}`;
  const entry = join(`.${key}.materialize-${'0'.repeat(36)}`, PACKAGE_ROOT);
  const stores = [join(root, `.opm-ci-${'0'.repeat(36)}`)];
  const shared = sharedStoreRoot(env);
  if (shared !== undefined) stores.push(shared);
  return Math.max(
    ...stores.map((store) => Buffer.byteLength(join(store, entry), 'utf8')),
  );
}

/** Refuse a lock whose patch names a path the system would not take below the store. */
export function assertPatchesFit(
  packages: readonly Pick<FrozenLockPackage, 'patch'>[],
  format: Pick<ProjectFormat, 'frozenPatchPathBytes'>,
  root: string,
  env: NodeJS.ProcessEnv,
): void {
  if (format.frozenPatchPathBytes === undefined) return;
  const directory = patchedPackageDirectoryBytes(root, env);
  const seen = new Set<string>();
  for (const { patch } of packages) {
    if (patch === undefined || seen.has(patch.digest)) continue;
    seen.add(patch.digest);
    const bytes = format.frozenPatchPathBytes(patch);
    const problem = wholePathProblem(directory, bytes);
    if (problem !== undefined)
      throw new OpmError(
        'UNSAFE_PATH',
        `the patch ${quote(patch.file)} (patchedDependencies ${quote(patch.key)}) names a path that ${problem}; keep the store (OPM_STORE_HOME) at a shorter path, or the patch's path shorter`,
      );
  }
}
