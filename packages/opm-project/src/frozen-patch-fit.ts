/**
 * A patched package's paths, held to what the system takes before anything is
 * fetched (ADR 0057 §13).
 *
 * The files of a patch are made in `.<key>.materialize-<uuid>/package/` below
 * the store, and a system call takes 4,095 bytes of path, the store's own
 * directories included. A patch is read without knowing where the store is, so
 * a path that passes every bound of its own (4,088 bytes, 127 segments, 255 a
 * name) can still be one the install cannot make. The plan and the install
 * know the project and the environment, which is enough to say how long the
 * directory can be at most: the shared store `OPM_STORE_HOME` names, or the
 * private one beside `node_modules`, whichever is longer, each at the longer
 * of its two forms: as it is written, and with the symlinks of its existing
 * ancestors followed, which is the path the host works on (`realpath` takes
 * no more than 4,095 bytes of it either). The install checks again with the
 * directory it really made, and also with the longest path the unpatched
 * package already holds, which a plan, with no archive, cannot see.
 */

import { join, relative, resolve } from 'node:path';
import {
  PACKAGE_ROOT,
  quote,
  wholePathProblem,
  type FrozenLockPackage,
  type ProjectFormat,
} from '@openpacker/adapter-core';
import { packageDirectory } from './frozen-scripts.js';
import {
  canonicalizeStableTarget,
  openStableDirectory,
  readDirChildWithTypes,
  storeKeyFromDigest,
} from './paths.js';
import { assertEntryName } from './shared-store.js';
import { sharedStoreRoot } from './shared-store-root.js';
import { OpmError } from './types.js';

const ZEROS = '0'.repeat(64);

/**
 * `path` in the form the system sees at its longest: as it is written, or with
 * the symlinks of its existing ancestors followed, whichever has more bytes.
 */
export async function longestForm(path: string): Promise<string> {
  const written = resolve(path);
  // A store that cannot be resolved is the install's to refuse, with its own error.
  const canonical = await canonicalizeStableTarget(written).catch(
    () => written,
  );
  return Buffer.byteLength(canonical, 'utf8') > Buffer.byteLength(written)
    ? canonical
    : written;
}

/** The longest directory, in bytes, a patched package of `root`'s project is made in. */
export async function patchedPackageDirectoryBytes(
  root: string,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  const key = `${storeKeyFromDigest(`sha256:${ZEROS}`)}-patch-${ZEROS}`;
  const entry = join(`.${key}.materialize-${'0'.repeat(36)}`, PACKAGE_ROOT);
  const stores = [join(root, `.opm-ci-${'0'.repeat(36)}`)];
  const shared = sharedStoreRoot(env);
  if (shared !== undefined) stores.push(shared);
  const lengths = await Promise.all(
    stores.map(async (store) =>
      Buffer.byteLength(join(await longestForm(store), entry), 'utf8'),
    ),
  );
  return Math.max(...lengths);
}

/** Refuse a lock whose patch names a path the system would not take below the store. */
export async function assertPatchesFit(
  packages: readonly Pick<FrozenLockPackage, 'patch'>[],
  format: Pick<ProjectFormat, 'frozenPatchPathBytes'>,
  root: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  // A lock that patches nothing has no store directory to fit: the setting is
  // the install's to read (and refuse), as it was before patches.
  if (
    format.frozenPatchPathBytes === undefined ||
    !packages.some(({ patch }) => patch !== undefined)
  )
    return;
  const directory = await patchedPackageDirectoryBytes(root, env);
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

/** The longest path below `directory`, of a file or a directory, with its length in bytes. */
async function deepestBelow(
  directory: string,
): Promise<{ path: string; bytes: number }> {
  let deepest = { path: '', bytes: 0 };
  const walk = async (path: string, below: string): Promise<void> => {
    const handle = await openStableDirectory(path);
    try {
      for (const entry of await readDirChildWithTypes(handle)) {
        assertEntryName(entry.name);
        const next = below === '' ? entry.name : `${below}/${entry.name}`;
        const bytes = Buffer.byteLength(next, 'utf8');
        if (bytes > deepest.bytes) deepest = { path: next, bytes };
        if (entry.isDirectory()) await walk(join(path, entry.name), next);
      }
    } finally {
      await handle.close();
    }
  };
  await walk(directory, '');
  return deepest;
}

const shown = (path: string): string =>
  path.length > 160 ? `${path.slice(0, 120)}...${path.slice(-30)}` : path;

/**
 * Refuse a package that already holds a path the system would not take in the
 * patched copy. The copy is made in a directory of its own, `where`, deeper
 * than the archive's entry it is copied from, so a path that was storable can
 * be one the copy cannot make, whatever the patch is.
 */
export async function assertBaseFits(
  label: string,
  unpatched: string,
  where: string,
): Promise<void> {
  const base = await packageDirectory(unpatched);
  const made = join(where, relative(unpatched, base));
  const deepest = await deepestBelow(base);
  const problem = wholePathProblem(
    Buffer.byteLength(made, 'utf8'),
    deepest.bytes,
  );
  if (problem !== undefined)
    throw new OpmError(
      'UNSAFE_PATH',
      `${label} already holds the path ${quote(shown(deepest.path))}, which ${problem}; patching copies the package into a directory of its own below the store, deeper than its archive's entry: keep the store (OPM_STORE_HOME) at a shorter path`,
    );
}
