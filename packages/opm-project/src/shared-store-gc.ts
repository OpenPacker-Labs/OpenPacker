/**
 * `opm gc --shared`: the only thing that ever removes a shared store entry.
 */

import { randomUUID } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { link, lstat, readdir, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  openStableDirectory,
  readDirChildWithTypes,
  removeStableFile,
  removeStableTree,
  storeKeyFromDigest,
} from './paths.js';
import { assertEntryName } from './shared-store.js';
import {
  INTEGRITY_INDEX,
  isIntegrityKey,
  lookupArchiveDigest,
} from './shared-store-index.js';
import { openCollection, type Collection } from './shared-store-lease.js';
import type { LeaseSteps } from './store-lease.js';
import {
  ensurePrivateRoot,
  requestedSharedStore,
} from './shared-store-root.js';

function isMissing(error: unknown): boolean {
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/**
 * Where something else may happen between gc's steps on an old orphan
 * `<key>.tree` record: a publish writing the record of that key. Only the
 * tests of that race give one; gc does nothing in between.
 */
export interface OrphanSteps {
  /** After the record was judged old, before it is moved aside. */
  judged?(record: string): Promise<void>;
  /** After it was moved aside, before it is looked at again. */
  movedAside?(record: string): Promise<void>;
}

export interface SharedStoreCollection {
  /** The shared root that was examined, when there is one. */
  root?: string;
  /**
   * Entries removed, or that would be on a dry run, with the leftovers of
   * installs that died and the records whose entry is gone.
   */
  removed: string[];
  /** Entries some project still links to, or that a kept patched copy was made from. */
  referenced: number;
  /** Unreferenced entries left alone because they are too new to judge. */
  tooNew: number;
  /** Unreferenced entries left alone because a running install claimed them. */
  held: number;
  /**
   * Integrity index records removed (or that would be, on a dry run): each
   * named an entry that is gone, whether this collection removed it or an
   * older one did, or names none at all.
   */
  records: string[];
}

/**
 * Remove shared entries that no project links to.
 *
 * A project's store entry and its `node_modules` are hard links to the
 * entry's files, so a file's link count is the number of places that still
 * hold it. An entry in which every file has a link count of one is held by
 * nothing but the shared root. Only this explicit command ever does it —
 * project `gc` never touches the shared root. It leaves an entry that a
 * running install has claimed (`shared-store-lease.ts`), which is how an entry
 * an install found but has not linked yet stays, and an entry younger than
 * `minimumAgeMs`, for an install that does not claim (an older opm).
 *
 * An entry's age is that of the newer of its record (`<entry>.tree`, by mtime)
 * and the entry directory itself (by ctime, from `lstat`): either one changed
 * within `minimumAgeMs` makes it too new. The record alone does not date a
 * publication, because a publish that finds the same record already on disk
 * does not write it again, and a record outlives its entry when a collection is
 * interrupted between the two removals or a publish fails before its rename.
 * The directory's ctime is set when the extraction fills it and moves again
 * when it is renamed into place (ext4 does, as measured; POSIX leaves it open),
 * so it dates the publication within the time an extraction takes, and nothing
 * can set it back.
 */
export function collectSharedStore(
  input: SharedStoreCollectionInput = {},
): Promise<SharedStoreCollection> {
  return collectSharedStoreWith(input, {});
}

export interface SharedStoreCollectionInput {
  dryRun?: boolean;
  minimumAgeMs?: number;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

/**
 * Points inside a collection where a test runs what may happen meanwhile. Not
 * part of the package's API: `index.ts` does not export `collectSharedStoreWith`.
 */
export interface SharedStoreCollectionSeams {
  /** With each entry it is about to decide on, once it found it unlinked. */
  beforeCollecting?: (entry: string) => Promise<void>;
  /** Where a test runs an install between the collection's lease steps. */
  step?: LeaseSteps;
  /** Where a test runs a publish between gc's steps on an orphan record. */
  orphan?: OrphanSteps;
}

/** `collectSharedStore` with the seams a test runs inside it. */
export async function collectSharedStoreWith(
  input: SharedStoreCollectionInput,
  seams: SharedStoreCollectionSeams,
): Promise<SharedStoreCollection> {
  const requested = requestedSharedStore(input.env ?? process.env);
  const result: SharedStoreCollection = {
    removed: [],
    referenced: 0,
    tooNew: 0,
    held: 0,
    records: [],
  };
  if (requested === undefined) return result;
  result.root = requested.root;
  const root = requested.root;
  try {
    // Looking at a store that is not there yet must not create it.
    await ensurePrivateRoot(root, requested.explicit, false);
  } catch (error) {
    if (isMissing(error)) return result;
    throw error;
  }
  const minimumAge = input.minimumAgeMs ?? 10 * 60 * 1000;
  const now = (input.now ?? Date.now)();
  // What an install or an earlier collection left half-done when it died.
  for (const leftover of await readdir(root, { withFileTypes: true })) {
    if (
      !(leftover.isDirectory() || leftover.isFile()) ||
      !/^\.sha256-[0-9a-f]{64}(?:-patch-[0-9a-f]{64})?\.(materialize|collect)-/u.test(
        leftover.name,
      )
    )
      continue;
    const path = join(root, leftover.name);
    const info = await stat(path).catch(() => undefined);
    if (info === undefined || now - info.mtimeMs < minimumAge) continue;
    result.removed.push(path);
    if (input.dryRun !== true)
      await (leftover.isDirectory() ? removeStableTree : removeStableFile)(
        path,
      ).catch(() => undefined);
  }
  const keys = (await readdir(root, { withFileTypes: true }))
    .filter(
      (entry) =>
        entry.isDirectory() &&
        // An archive's files, or a patched copy of them (ADR 0057).
        /^sha256-[0-9a-f]{64}(?:-patch-[0-9a-f]{64})?$/u.test(entry.name),
    )
    .map((entry) => entry.name)
    .sort();
  const collection = await openCollection(
    root,
    input.dryRun === true,
    seams.step,
  );
  // A patched copy is judged before the entry it was made from (ADR 0057):
  // while the copy is kept, so is that entry, which an install proves to be
  // the package its lock names before it adopts the copy, offline too.
  const needed = new Set<string>();
  const keep = (key: string) => {
    const at = key.indexOf('-patch-');
    if (at !== -1) needed.add(key.slice(0, at));
  };
  try {
    for (const key of [
      ...keys.filter((name) => name.includes('-patch-')),
      ...keys.filter((name) => !name.includes('-patch-')),
    ]) {
      const entry = join(root, key);
      if (needed.has(key)) {
        result.referenced += 1;
        continue;
      }
      // Another collection may have removed it since the directory was listed:
      // counted nowhere, as the second look does.
      const linked = await hasLinkedFile(entry).catch((error: unknown) => {
        if (isMissing(error)) return undefined;
        throw error;
      });
      if (linked === undefined) continue;
      if (linked) {
        result.referenced += 1;
        keep(key);
        continue;
      }
      const published = await publishedAt(entry);
      if (published !== undefined && now - published < minimumAge) {
        result.tooNew += 1;
        keep(key);
        continue;
      }
      await seams.beforeCollecting?.(entry);
      const verdict = await collect(collection, root, key, input.dryRun);
      if (verdict === 'removed') result.removed.push(entry);
      else if (verdict !== 'gone') {
        result[verdict] += 1;
        keep(key);
      }
    }
  } finally {
    await collection.release();
  }
  await collectOrphanRecords(
    root,
    now - minimumAge,
    input.dryRun,
    result,
    seams.orphan,
  );
  await collectIndexRecords(root, now - minimumAge, input.dryRun, result);
  return result;
}

/**
 * Remove each integrity index record whose entry is gone: the ones that named
 * an entry this collection just removed, and the ones an older collection left
 * behind (it removed entries and not their records). A record never outlives
 * its entry. An install writes a record only after its entry is in place, so
 * a record with no entry is dead, except one whose entry an install is
 * publishing right now (`.<key>.materialize-…`), which is left to it. A
 * malformed record names nothing and goes too. Each is moved aside first, and
 * put back if an install wrote it again meanwhile or its entry appeared, so
 * nothing an install just recorded is lost. Leftovers of a collection that
 * died while moving one are removed once old.
 */
async function collectIndexRecords(
  root: string,
  before: number,
  dryRun: boolean | undefined,
  result: SharedStoreCollection,
): Promise<void> {
  const index = join(root, INTEGRITY_INDEX);
  const names = await readdir(index).catch((error: unknown) => {
    if (isMissing(error)) return [];
    throw error;
  });
  // On a dry run the entries it would remove are still there: count them gone.
  const collected = new Set(
    result.removed.map((path) => path.slice(root.length + 1)),
  );
  const present = new Set(
    (await readdir(root)).filter((name) => !collected.has(name)),
  );
  const busy = new Set(
    [...present].flatMap(
      (name) => /^\.(sha256-[0-9a-f]{64})\.materialize-/u.exec(name)?.[1] ?? [],
    ),
  );
  const named = async (key: string) => {
    const digest = await lookupArchiveDigest(root, key);
    return digest === undefined ? undefined : storeKeyFromDigest(digest);
  };
  for (const name of names.sort()) {
    const path = join(index, name);
    if (/^\..+\.collect-[0-9a-f-]{36}$/u.test(name)) {
      const info = await lstat(path).catch(() => undefined);
      if (dryRun !== true && info !== undefined && info.mtimeMs < before)
        await removeStableFile(path).catch(() => undefined);
      continue;
    }
    if (!isIntegrityKey(name)) continue;
    const judged = await lstat(path, { bigint: true }).catch(() => undefined);
    if (judged?.isFile() !== true) continue;
    const entry = await named(name);
    if (entry !== undefined && (present.has(entry) || busy.has(entry)))
      continue;
    if (dryRun === true) {
      result.records.push(path);
      continue;
    }
    const doomed = join(index, `.${name}.collect-${randomUUID()}`);
    if (
      !(await rename(path, doomed).then(
        () => true,
        () => false,
      ))
    )
      continue;
    const moved = await lstat(doomed, { bigint: true });
    const appeared =
      entry !== undefined &&
      (await lstat(join(root, entry)).then(
        () => true,
        () => false,
      ));
    if (appeared || !sameRecord(judged, moved))
      // Never over a record written since.
      await link(doomed, path).catch(() => undefined);
    else result.records.push(path);
    await removeStableFile(doomed).catch(() => undefined);
  }
}

/**
 * Remove one unreferenced entry unless an install claims it or something
 * links it by now. Announced first and settled once the entry is unpublished,
 * so an install that wants it meanwhile waits and then publishes it again.
 * `gone` is an entry another collection removed first: this one counts it
 * nowhere.
 */
async function collect(
  collection: Collection,
  root: string,
  key: string,
  dryRun: boolean | undefined,
): Promise<'removed' | 'held' | 'referenced' | 'gone'> {
  const entry = join(root, key);
  const doomed = join(root, `.${key}.collect-${randomUUID()}`);
  try {
    if (await collection.claimed(key)) return 'held';
    // Linked by an install that finished since the first look. What cannot
    // be looked through counts as held, as anything unclear does.
    const linked = await hasLinkedFile(entry).then(
      (yes) => (yes ? 'referenced' : undefined),
      (error: unknown) => (isMissing(error) ? 'gone' : 'held'),
    );
    if (linked !== undefined) return linked;
    if (dryRun === true) return 'removed';
    // Unpublish atomically, so an install never reads half of it.
    await rename(entry, doomed).catch((error: unknown) => {
      if (!isMissing(error)) throw error;
    });
    await removeStableFile(`${entry}.tree`).catch(() => undefined);
    await removeStableFile(`${entry}.artifact`).catch(() => undefined);
  } finally {
    await collection.settled(key);
  }
  await removeStableTree(doomed).catch(() => undefined);
  return 'removed';
}

/**
 * True when `moved` is the file `judged` was: the same device and inode, and
 * not written since (modified time to the nanosecond, and size). An inode
 * number can be reused, so the pair alone is not the file.
 */
export function sameRecord(
  judged: Pick<BigIntStats, 'dev' | 'ino' | 'mtimeNs' | 'size'>,
  moved: Pick<BigIntStats, 'dev' | 'ino' | 'mtimeNs' | 'size'>,
): boolean {
  return (
    judged.dev === moved.dev &&
    judged.ino === moved.ino &&
    judged.mtimeNs === moved.mtimeNs &&
    judged.size === moved.size
  );
}

/**
 * Remove every `<key>.tree` whose entry is gone and that is older than
 * `before`: an install or a collection that stopped between the record and
 * the entry leaves one, and no publish of that key may follow. A young one
 * may be a publish about to rename its entry into place. The record is moved
 * aside before it is removed, and put back if a publish replaced it in the
 * meantime (an atomic replace is a new inode).
 */
async function collectOrphanRecords(
  root: string,
  before: number,
  dryRun: boolean | undefined,
  result: SharedStoreCollection,
  steps: OrphanSteps = {},
): Promise<void> {
  const names = new Set(await readdir(root));
  // A key another collection is removing, or an install is making, is theirs:
  // that collection removes the record with the entry, and that publish
  // writes it over.
  const busy = new Set(
    [...names].flatMap(
      (name) =>
        /^\.(sha256-[0-9a-f]{64}(?:-patch-[0-9a-f]{64})?)\.(?:collect|materialize)-/u.exec(
          name,
        )?.[1] ?? [],
    ),
  );
  for (const name of [...names].sort()) {
    const key = /^(sha256-[0-9a-f]{64}(?:-patch-[0-9a-f]{64})?)\.tree$/u.exec(
      name,
    )?.[1];
    if (key === undefined || names.has(key) || busy.has(key)) continue;
    const path = join(root, name);
    const judged = await lstat(path, { bigint: true }).catch(() => undefined);
    if (judged?.isFile() !== true || Number(judged.mtimeMs) >= before) continue;
    if (dryRun === true) {
      result.removed.push(path);
      continue;
    }
    const doomed = join(root, `.${key}.collect-${randomUUID()}`);
    await steps.judged?.(path);
    if (
      !(await rename(path, doomed).then(
        () => true,
        () => false,
      ))
    )
      continue;
    await steps.movedAside?.(path);
    const moved = await lstat(doomed, { bigint: true });
    // Removed only if it is the record that was judged; a record written
    // since goes back, and was never removed. (For the instant between the
    // move and the link a reader finds no record: an archive's adopter is told
    // its entry has none and can run again, a patched entry's is made again
    // and compared, `frozen-patch.ts`.)
    if (!sameRecord(judged, moved))
      // Never over a record written since.
      await link(doomed, path).catch(() => undefined);
    else result.removed.push(path);
    await removeStableFile(doomed).catch(() => undefined);
  }
}

/**
 * When `entry` was last published, in ms: the newer of its record's mtime and
 * the directory's own ctime (never through a link), or undefined when neither
 * can be read.
 */
async function publishedAt(entry: string): Promise<number | undefined> {
  const [record, directory] = await Promise.all([
    stat(`${entry}.tree`).catch(() => undefined),
    lstat(entry).catch(() => undefined),
  ]);
  const times = [record?.mtimeMs, directory?.ctimeMs].filter(
    (time): time is number => time !== undefined,
  );
  return times.length === 0 ? undefined : Math.max(...times);
}

/** True when any file under `entry` has a second name somewhere else. */
async function hasLinkedFile(entry: string): Promise<boolean> {
  const handle = await openStableDirectory(entry);
  try {
    for (const child of await readDirChildWithTypes(handle)) {
      assertEntryName(child.name);
      const path = join(entry, child.name);
      if (child.isDirectory()) {
        if (await hasLinkedFile(path)) return true;
        continue;
      }
      if (child.isFile() && (await lstat(path)).nlink > 1) return true;
    }
    return false;
  } finally {
    await handle.close();
  }
}
