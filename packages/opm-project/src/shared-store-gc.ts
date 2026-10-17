/**
 * `opm gc --shared`: the only thing that ever removes a shared store entry.
 */

import { randomUUID } from 'node:crypto';
import { link, lstat, readdir, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  openStableDirectory,
  readDirChildWithTypes,
  removeStableFile,
  removeStableTree,
} from './paths.js';
import { assertEntryName } from './shared-store.js';
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
}

/**
 * Remove shared entries that no project links to.
 *
 * A project's store entry and its `node_modules` are hard links to the
 * entry's files, so a file's link count is the number of places that still
 * hold it. An entry in which every file has a link count of one is held by
 * nothing but the shared root. Only this explicit command ever does it —
 * project `gc` never touches the shared root — and it leaves an entry younger
 * than `minimumAgeMs`, which a concurrent install may be about to link.
 */
export async function collectSharedStore(
  input: {
    dryRun?: boolean;
    minimumAgeMs?: number;
    env?: NodeJS.ProcessEnv;
    now?: () => number;
    steps?: OrphanSteps;
  } = {},
): Promise<SharedStoreCollection> {
  const requested = requestedSharedStore(input.env ?? process.env);
  const result: SharedStoreCollection = {
    removed: [],
    referenced: 0,
    tooNew: 0,
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
        // An archive's files, or a patched copy of them (ADR 0056).
        /^sha256-[0-9a-f]{64}(?:-patch-[0-9a-f]{64})?$/u.test(entry.name),
    )
    .map((entry) => entry.name)
    .sort();
  // A patched copy is judged before the entry it was made from (ADR 0056):
  // while the copy is kept, so is that entry, which an install proves to be
  // the package its lock names before it adopts the copy, offline too.
  const needed = new Set<string>();
  const keep = (key: string) => {
    const at = key.indexOf('-patch-');
    if (at !== -1) needed.add(key.slice(0, at));
  };
  for (const key of [
    ...keys.filter((name) => name.includes('-patch-')),
    ...keys.filter((name) => !name.includes('-patch-')),
  ]) {
    const entry = join(root, key);
    if (needed.has(key) || (await hasLinkedFile(entry))) {
      result.referenced += 1;
      keep(key);
      continue;
    }
    // Dated by its record, or, while it has none, by the directory itself: a
    // patched entry is renamed into place before its record is written.
    const published = await stat(`${entry}.tree`).then(
      (record) => record.mtimeMs,
      async () => (await lstat(entry).catch(() => undefined))?.ctimeMs,
    );
    if (published !== undefined && now - published < minimumAge) {
      result.tooNew += 1;
      keep(key);
      continue;
    }
    result.removed.push(entry);
    if (input.dryRun === true) continue;
    // Unpublish first, atomically, so an install that races this sees the
    // entry vanish and publishes it again rather than reading half of it.
    const doomed = join(root, `.${key}.collect-${randomUUID()}`);
    await rename(entry, doomed).catch((error: unknown) => {
      if (!isMissing(error)) throw error;
    });
    await removeStableTree(doomed).catch(() => undefined);
    await removeStableFile(`${entry}.tree`).catch(() => undefined);
    await removeStableFile(`${entry}.artifact`).catch(() => undefined);
  }
  await collectOrphanRecords(
    root,
    now - minimumAge,
    input.dryRun,
    result,
    input.steps,
  );
  return result;
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
  for (const name of [...names].sort()) {
    const key = /^(sha256-[0-9a-f]{64}(?:-patch-[0-9a-f]{64})?)\.tree$/u.exec(
      name,
    )?.[1];
    if (key === undefined || names.has(key)) continue;
    const path = join(root, name);
    const judged = await lstat(path).catch(() => undefined);
    if (judged?.isFile() !== true || judged.mtimeMs >= before) continue;
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
    const moved = await lstat(doomed);
    // Removed only if it is the record that was judged; a record written
    // since goes back, and was never removed. (For the instant between the
    // move and the link a reader finds no record: an archive's adopter is told
    // its entry has none and can run again, a patched entry's is made again
    // and compared, `frozen-patch.ts`.)
    if (moved.ino !== judged.ino || moved.dev !== judged.dev)
      // Never over a record written since.
      await link(doomed, path).catch(() => undefined);
    else result.removed.push(path);
    await removeStableFile(doomed).catch(() => undefined);
  }
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
