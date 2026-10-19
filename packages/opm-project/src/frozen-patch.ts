/**
 * A patched package is a package of its own (ADR 0056).
 *
 * pnpm applies a `patchedDependencies` patch to the package's files in its
 * virtual store, in a directory whose name carries the patch's hash
 * (`name@1.0.0_patch_hash=...`), and keeps the unpatched files in its store
 * apart from it (the side-effects cache key holds `patchFileHash` too). opm
 * does the same with its shared store: the patched files are an entry of
 * their own, `sha256-<archive>-patch-<sha256 of the patch file's bytes>`, so
 * a project that installs the package unpatched never links a patched file,
 * one that patches it never links an unpatched one, and two patches, or an LF
 * and a CRLF checkout of one, never share one.
 *
 * The entry is made the way an archive's is: in a temporary directory beside
 * it (`.<key>.materialize-<uuid>`, which `opm gc --shared` clears when it is
 * left behind), from a copy of the unpatched entry (never its files: they are
 * every project's), patched there by the format (`applyFrozenPatch`), hashed,
 * sealed read-only, and renamed into place. Only the install whose rename
 * won records the tree digest in `<key>.tree`, after the rename: an install
 * that lost never writes a record for a tree that is not the one in place.
 * An entry that is there already is adopted after its tree is hashed again
 * against that record, as an archive's is, and one whose record its
<<<<<<< ours
 * publisher has not written yet is waited for. A publisher that died between
 * the rename and the record leaves an entry with no record for good, so after
 * the wait the install makes the tree again from the unpatched entry it has
 * proved, and records the entry in place only if it is that tree. The unpatched entry was proved
=======
 * publisher has not written yet is waited for. The unpatched entry was proved
>>>>>>> theirs
 * to be the package the lock names before this runs: the patch is applied to
 * bytes that are known, and a patch that changes `package.json` changes what
 * is installed, not what was checked.
 */

import { randomUUID } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
<<<<<<< ours
import {
  PACKAGE_TREE_LIMITS,
  type FrozenLockPackage,
  type FrozenPatch,
  type ProjectFormat,
=======
import type {
  FrozenLockPackage,
  FrozenPatch,
  ProjectFormat,
>>>>>>> theirs
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

/** What of a lock's package patching reads. */
type PatchedPackage = Pick<
  FrozenLockPackage,
  'path' | 'packageName' | 'version' | 'patch'
>;

/** What of a format patching calls. */
type PatchFormat = Pick<ProjectFormat, 'applyFrozenPatch'>;

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

/**
 * How long an entry another install has renamed into place may be without its
<<<<<<< ours
 * record before it is taken for one whose publisher died, and checked by
 * making its tree again: that install writes the record right after the
 * rename.
=======
 * record before it is taken for one whose publisher died: that install writes
 * the record right after the rename.
>>>>>>> theirs
 */
const RECORD_WAIT_MS = 10_000;

const isThere = (path: string): Promise<boolean> =>
  lstat(path).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    },
  );

<<<<<<< ours
/** Wait while `path` is in place and its record is not, for up to `waitMs`. */
async function recordedOrGone(path: string, waitMs: number): Promise<void> {
  const deadline = Date.now() + waitMs;
=======
/** Wait while `path` is in place and its record is not, for up to `RECORD_WAIT_MS`. */
async function recordedOrGone(path: string): Promise<void> {
  const deadline = Date.now() + RECORD_WAIT_MS;
>>>>>>> theirs
  while (
    Date.now() < deadline &&
    !(await isThere(`${path}.tree`)) &&
    (await isThere(path))
  )
    await new Promise((resolve) => setTimeout(resolve, 20));
}

<<<<<<< ours
/** What making the patched entry takes. */
interface PublishInput {
=======
/** Make, or adopt, the patched entry of one archive and one patch. */
async function publishPatched(input: {
>>>>>>> theirs
  storeRoot: string;
  shared: boolean;
  unpatched: StoredEntry;
  patch: FrozenPatch;
  label: string;
  format: PatchFormat;
<<<<<<< ours
  /** How long to wait for another install's record; `RECORD_WAIT_MS` if absent. */
  recordWaitMs?: number;
  /** The most files the patched entry may hold; an archive's, if absent. */
  maximumFiles?: number;
}

/**
 * Files in a store tree. Past `limit` the walk stops: the answer is that it
 * is over, and the tree is not read to the end.
 */
async function countFiles(path: string, limit: number): Promise<number> {
  const handle = await openStableDirectory(path);
  try {
    let count = 0;
    for (const entry of await readDirChildWithTypes(handle)) {
      assertEntryName(entry.name);
      if (entry.isDirectory())
        count += await countFiles(join(path, entry.name), limit - count);
      else count += 1;
      if (count > limit) break;
    }
    return count;
  } finally {
    await handle.close();
  }
}

/** The unpatched entry copied to `tmp` and patched there; the tree's digest. */
async function buildPatched(input: PublishInput, tmp: string): Promise<string> {
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
  // The patch may have added to a package already at the limit.
  const limit = input.maximumFiles ?? PACKAGE_TREE_LIMITS.maximumFiles;
  const files = await countFiles(tmp, limit);
  if (files > limit)
    throw new OpmError(
      'SIZE_LIMIT',
      `${input.label} patched by ${input.patch.file} would hold more than the ${limit} files a package may hold`,
    );
  return stableStoreTreeDigest(tmp);
}

/**
 * Record an entry in place that has no record, if its files are the tree the
 * patch gives: made again in a temporary directory beside it from the
 * unpatched entry, whose archive was proved to be the package the lock names.
 * An entry that is not that tree is never trusted, and is the error an
 * unrecorded entry always was.
 */
async function recordUnrecorded(
  input: PublishInput,
  key: string,
  path: string,
): Promise<void> {
  const tmp = join(input.storeRoot, `.${key}.materialize-${randomUUID()}`);
  try {
    const made = await buildPatched(input, tmp);
    // An entry that is gone, or a record that came meanwhile, is the caller's to see.
    if (!(await isThere(path)) || (await isThere(`${path}.tree`))) return;
    const inPlace = await stableStoreTreeDigest(path).catch(
      (error: NodeJS.ErrnoException) => {
        // Removed while it was read: there is nothing to record.
        if (error.code === 'ENOENT') return undefined;
        throw error;
      },
    );
    if (inPlace === undefined) return;
    if (inPlace !== made)
      throw new OpmError(
        'VERIFICATION_FAILED',
        `Shared store entry ${key} has no tree digest and is not the tree its patch gives; ` +
          `remove ${path} and ${path}.tree and run the command again`,
      );
    await recordTreeDigest(path, made);
  } finally {
    await removeStableTree(tmp).catch(() => undefined);
  }
}

/** Make, or adopt, the patched entry of one archive and one patch. */
async function publishPatched(input: PublishInput): Promise<string> {
=======
}): Promise<string> {
>>>>>>> theirs
  const key = patchedStoreKey(input.unpatched.digest, input.patch.digest);
  const path = join(input.storeRoot, key);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (input.shared) {
<<<<<<< ours
      await recordedOrGone(path, input.recordWaitMs ?? RECORD_WAIT_MS);
      if ((await isThere(path)) && !(await isThere(`${path}.tree`)))
        await recordUnrecorded(input, key, path);
=======
      await recordedOrGone(path);
>>>>>>> theirs
      if ((await adoptExistingEntry(path, key)) !== undefined) return path;
    }
    const tmp = join(input.storeRoot, `.${key}.materialize-${randomUUID()}`);
    try {
<<<<<<< ours
      const treeDigest = await buildPatched(input, tmp);
=======
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
>>>>>>> theirs
      if (input.shared) await sealTreeReadOnly(tmp);
      try {
        await rename(tmp, path);
      } catch (error) {
        // SAFETY: Node file errors carry an optional string `code`.
        const code = (error as NodeJS.ErrnoException).code;
        // Another install published the same entry first: adopt its tree.
        if (code !== 'ENOTEMPTY' && code !== 'EEXIST') throw error;
        continue;
      }
      // This tree is the one in place, so this install says what it hashes to.
      await recordTreeDigest(path, treeDigest);
      return path;
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
  lock: { readonly packages: readonly PatchedPackage[] };
  byPath: ReadonlyMap<string, StoredEntry>;
  storeRoot: string;
  shared: boolean;
  format: PatchFormat;
<<<<<<< ours
  recordWaitMs?: number;
  maximumFiles?: number;
=======
>>>>>>> theirs
}): Promise<{
  byPath: Map<string, StoredEntry>;
  patched: { packages: number; patches: number };
}> {
  const byPath = new Map(input.byPath);
  const made = new Map<string, Promise<string>>();
  const patched = input.lock.packages.filter(
    (pkg): pkg is PatchedPackage & { patch: FrozenPatch } =>
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
<<<<<<< ours
        ...(input.recordWaitMs !== undefined && {
          recordWaitMs: input.recordWaitMs,
        }),
        ...(input.maximumFiles !== undefined && {
          maximumFiles: input.maximumFiles,
        }),
=======
>>>>>>> theirs
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
