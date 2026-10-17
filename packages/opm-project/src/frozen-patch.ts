/**
 * A patched package is a package of its own (ADR 0056).
 *
 * pnpm applies a `patchedDependencies` patch to the package's files in its
 * virtual store, in a directory whose name carries the patch's hash
 * (`name@1.0.0_patch_hash=...`), and keeps the unpatched files in its store
 * apart from it (the side-effects cache key holds `patchFileHash` too). opm
 * does the same with its shared store: the patched files are an entry of
 * their own, `sha256-<archive>-patch-<sha256 of the patch>`, so a project
 * that installs the package unpatched never links a patched file, one that
 * patches it never links an unpatched one, and two patches never share one.
 *
 * The entry is made the way an archive's is: in a temporary directory beside
 * it (`.<key>.materialize-<uuid>`, which `opm gc --shared` clears when it is
 * left behind), from a copy of the unpatched entry (never its files: they are
 * every project's), patched there by the format (`applyFrozenPatch`), hashed,
 * sealed read-only, its tree digest recorded in `<key>.tree`, and only then
 * renamed into place. An entry that is there already is adopted after its
 * tree is hashed again against that record, as an archive's is. The
 * unpatched entry was proved to be the package the lock names before this
 * runs: the patch is applied to bytes that are known, and a patch that
 * changes `package.json` changes what is installed, not what was checked.
 */

import { randomUUID } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  FrozenLock,
  FrozenLockPackage,
  FrozenPatch,
  ProjectFormat,
} from '@openpacker/adapter-core';
import { adapterFailure } from './frozen-prepare.js';
import { packageDirectory } from './frozen-scripts.js';
import { stableStoreTreeDigest } from './generations.js';
import {
  openStableDirectory,
  readDirChildWithTypes,
  removeStableTree,
  storeKeyFromDigest,
} from './paths.js';
import {
  adoptExistingEntry,
  assertEntryName,
  recordTreeDigest,
  sealTreeReadOnly,
} from './shared-store.js';
import { OpmError } from './types.js';

/** An archive (or a patched copy of one) in a store. */
export interface StoredEntry {
  path: string;
  digest: string;
  fetchedBytes: number;
  fetched: boolean;
}

/** The store key of `digest`'s files with the patch whose sha256 is `patch`. */
export function patchedStoreKey(digest: string, patch: string): string {
  if (!/^[0-9a-f]{64}$/u.test(patch))
    throw new OpmError('INVALID_DIGEST', `Invalid patch digest ${patch}`);
  return `${storeKeyFromDigest(digest)}-patch-${patch}`;
}

/** Copy a store tree, every file a writable file of its own. */
async function copyTree(from: string, to: string): Promise<void> {
  await mkdir(to);
  const handle = await openStableDirectory(from);
  try {
    for (const entry of await readDirChildWithTypes(handle)) {
      assertEntryName(entry.name);
      const source = join(from, entry.name);
      const target = join(to, entry.name);
      if (entry.isDirectory()) await copyTree(source, target);
      else if (entry.isFile() && !entry.isSymbolicLink()) {
        await copyFile(source, target);
        await chmod(target, ((await lstat(source)).mode & 0o777) | 0o200);
      } else
        throw new OpmError(
          'UNSAFE_PATH',
          `Store entry holds something that is not a file or a directory: ${source}`,
        );
    }
  } finally {
    await handle.close();
  }
}

/** Make, or adopt, the patched entry of one archive and one patch. */
async function publishPatched(input: {
  storeRoot: string;
  shared: boolean;
  unpatched: StoredEntry;
  patch: FrozenPatch;
  label: string;
  format: ProjectFormat;
}): Promise<string> {
  const key = patchedStoreKey(input.unpatched.digest, input.patch.digest);
  const path = join(input.storeRoot, key);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (input.shared && (await adoptExistingEntry(path, key)) !== undefined)
      return path;
    const tmp = join(input.storeRoot, `.${key}.materialize-${randomUUID()}`);
    try {
      await copyTree(input.unpatched.path, tmp);
      try {
        await input.format.applyFrozenPatch!(
          await packageDirectory(tmp),
          input.patch,
          input.label,
        );
      } catch (error) {
        throw adapterFailure(error);
      }
      const treeDigest = await stableStoreTreeDigest(tmp);
      if (input.shared) await sealTreeReadOnly(tmp);
      await recordTreeDigest(path, treeDigest);
      try {
        await rename(tmp, path);
        return path;
      } catch (error) {
        // SAFETY: Node file errors carry an optional string `code`.
        const code = (error as NodeJS.ErrnoException).code;
        // Another install published the same entry first: adopt it.
        if (code !== 'ENOTEMPTY' && code !== 'EEXIST') throw error;
      }
    } finally {
      await removeStableTree(tmp).catch(() => undefined);
    }
  }
  throw new OpmError(
    'VERIFICATION_FAILED',
    `Shared store entry ${key} kept changing while it was published`,
  );
}

/**
 * Replace, for every package the lock patches, the archive's entry with the
 * patched one, made once per archive and patch. Runs after the archives were
 * proved to be the packages the lock names, and before anything is linked.
 */
export async function patchArchives(input: {
  lock: FrozenLock;
  byPath: ReadonlyMap<string, StoredEntry>;
  storeRoot: string;
  shared: boolean;
  format: ProjectFormat;
}): Promise<{
  byPath: Map<string, StoredEntry>;
  patched: { packages: number; patches: number };
}> {
  const byPath = new Map(input.byPath);
  const made = new Map<string, Promise<string>>();
  const patched = input.lock.packages.filter(
    (pkg): pkg is FrozenLockPackage & { patch: FrozenPatch } =>
      pkg.patch !== undefined,
  );
  if (patched.length > 0 && input.format.applyFrozenPatch === undefined)
    throw new OpmError(
      'UNSUPPORTED_LOCK',
      `the lock patches ${patched.length} package${patched.length === 1 ? '' : 's'}, and this ecosystem's format cannot apply a patch`,
    );
  // One at a time: a patch is small, and two that fail should not race to say so.
  for (const pkg of patched) {
    const unpatched = input.byPath.get(pkg.path)!;
    const id = `${unpatched.digest}\0${pkg.patch.digest}`;
    let entry = made.get(id);
    if (entry === undefined) {
      entry = publishPatched({
        storeRoot: input.storeRoot,
        shared: input.shared,
        unpatched,
        patch: pkg.patch,
        label: `${pkg.packageName}@${pkg.version}`,
        format: input.format,
      });
      made.set(id, entry);
    }
    byPath.set(pkg.path, { ...unpatched, path: await entry });
  }
  return {
    byPath,
    patched: {
      packages: made.size,
      patches: new Set(patched.map((pkg) => pkg.patch.key)).size,
    },
  };
}
