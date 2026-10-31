import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, rmdir, stat, type FileHandle } from 'node:fs/promises';
import { basename } from 'node:path';
import { lstatChild } from '@openpacker/project-io';
import { isRefusal, opmEntry, plainReason } from './fs-reason.js';
import {
  openChild,
  openStableDirectory,
  readDirChild,
  readStableFileAt,
  removeChild,
  type ProjectPaths,
} from './paths.js';
import {
  currentOwner,
  describeProcessOwner,
  parseProcessOwner,
  isOwnerAlive,
  type ProcessOwner,
} from './process-owner.js';
import { OpmError } from './types.js';

/**
 * One step at a time changes a project (ADR 0056 §5).
 *
 * The lock is the set of files `.opm/step-<uuid>.lock`, each naming the
 * process that wrote it ({@link ProcessOwner}). A step writes its own file
 * with `O_EXCL`, then lists the others: it holds the lock when none of them
 * may still be running. Otherwise it removes its own file, waits and tries
 * again, and after `waitMs` refuses with `PROJECT_BUSY`, naming the holder.
 *
 * Two steps cannot both hold it: each listed the others after its own file
 * existed, so whichever listed second saw the first's file. A file whose owner
 * is gone is removed by whoever sees it; its name is that owner's alone, so
 * removing it can never take a live step's lock away (one shared name would
 * need a compare-and-delete the file system does not have).
 */

const PREFIX = 'step-';
const SUFFIX = '.lock';
/** A lock file is written as it is created; one still empty after this was cut short. */
const PARTIAL_AFTER_MS = 5_000;
const LOCK_FILE_BYTES = 4096;

export interface StepLockHolder {
  /** `.opm/step-<uuid>.lock`, as a message shows it (control characters are `?`). */
  file: string;
  /** Who holds it; absent when the file cannot be read as a lock. */
  owner?: ProcessOwner;
}

/** A lock file that was removed: because its owner is gone, or because the operator said so. */
export interface RemovedLock {
  file: string;
  /** Who held it; absent for a lock that did not say. */
  owner?: ProcessOwner;
}

export interface StepLock {
  /** The locks of owners that are gone, removed on the way. */
  readonly removed: readonly RemovedLock[];
  release(): Promise<void>;
}

/** The id of a step lock file, `step-<id>.lock`: what `opm recover --abandon-step` names. */
export function stepLockId(file: string): string | undefined {
  const name = basename(file);
  return name.startsWith(PREFIX) && name.endsWith(SUFFIX)
    ? name.slice(PREFIX.length, -SUFFIX.length)
    : undefined;
}

/**
 * Take the project's step lock. `undefined` when the project directory does not
 * exist: there is nothing in it to change or to put back.
 */
export async function acquireStepLock(
  paths: ProjectPaths,
  options: {
    waitMs: number;
    onWait?: (holder: StepLockHolder) => void;
    /**
     * Owners to take as gone whatever the system says: the operator asserted
     * that their step is dead (`opm recover --abandon-step`).
     */
    abandoned?: (owner: ProcessOwner) => boolean;
    /**
     * Lock files (`step-<id>.lock`) to remove whatever they hold: the operator
     * asserted that no step is behind them, for a lock that does not say who
     * holds it (`opm recover --abandon-step <id> --force`).
     */
    abandonedFiles?: ReadonlySet<string>;
  },
): Promise<StepLock | undefined> {
  const root = await stat(paths.root).catch(() => undefined);
  if (root === undefined || !root.isDirectory()) return undefined;
  const createdOpmDir =
    (await lstat(paths.opmDir).catch(() => undefined)) === undefined;
  const name = `${PREFIX}${randomUUID()}${SUFFIX}`;
  const body = `${JSON.stringify({
    lockVersion: 1,
    owner: await currentOwner(),
  })}\n`;
  const deadline = Date.now() + options.waitMs;
  let told = false;
  for (;;) {
    const dir = await openLockDirectory(paths);
    try {
      if (await createLockFile(dir, name, body, paths)) {
        const removed: RemovedLock[] = [];
        const holders = await liveHolders(
          dir,
          name,
          options.abandoned,
          options.abandonedFiles,
          removed,
        );
        if (holders.length === 0)
          return held(paths, dir, name, createdOpmDir, removed);
        await removeChild(dir, name, { force: true });
        if (Date.now() >= deadline) throw busy(holders[0]!);
        if (!told) options.onWait?.(holders[0]!);
        told = true;
      }
    } catch (error) {
      await dir.close().catch(() => undefined);
      throw error;
    }
    await dir.close();
    // Apart, so that two steps that saw each other do not meet again.
    await new Promise((resolve) =>
      setTimeout(resolve, 50 + Math.random() * 100),
    );
  }
}

/** `.opm`, made if need be; a file system that refuses is said plainly. */
async function openLockDirectory(paths: ProjectPaths): Promise<FileHandle> {
  try {
    return await openStableDirectory(paths.opmDir, true);
  } catch (error) {
    throw error instanceof Error && isRefusal(error)
      ? cannotLock(paths, error)
      : error;
  }
}

/**
 * A project opm cannot take the lock of: a read-only file system, a directory
 * it may not write. Nothing was changed, and nothing says "/proc/self/fd".
 */
function cannotLock(paths: ProjectPaths, error: NodeJS.ErrnoException) {
  return new OpmError(
    'UNAVAILABLE',
    `opm cannot change this project, because it cannot create a step lock in ${paths.opmDir} (${plainReason(error)}). Nothing was changed.`,
    { cause: error },
  );
}

/** False when `.opm` went away under it (removed by a step that made it). */
async function createLockFile(
  dir: FileHandle,
  name: string,
  body: string,
  paths: ProjectPaths,
): Promise<boolean> {
  let file: FileHandle;
  try {
    file = await openChild(
      dir,
      name,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o644,
    );
  } catch (error) {
    // SAFETY: only the errno code of a file-system error is read.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error instanceof Error && isRefusal(error)
      ? cannotLock(paths, error)
      : error;
  }
  try {
    await file.writeFile(body);
    await file.sync();
  } finally {
    await file.close();
  }
  return true;
}

function held(
  paths: ProjectPaths,
  dir: FileHandle,
  name: string,
  createdOpmDir: boolean,
  removed: readonly RemovedLock[],
): StepLock {
  let released = false;
  return {
    removed,
    release: async () => {
      if (released) return;
      released = true;
      try {
        await removeChild(dir, name, { force: true });
      } finally {
        await dir.close();
      }
      // `opm ci` in a project opm never touched leaves no `.opm` behind.
      if (createdOpmDir) await rmdir(paths.opmDir).catch(() => undefined);
    },
  };
}

/** The other lock files whose owner may be running; gone owners' are removed. */
async function liveHolders(
  dir: FileHandle,
  own: string,
  abandoned: ((owner: ProcessOwner) => boolean) | undefined,
  abandonedFiles: ReadonlySet<string> | undefined,
  removed: RemovedLock[],
): Promise<StepLockHolder[]> {
  const holders: StepLockHolder[] = [];
  for (const entry of (await readDirChild(dir)).sort()) {
    if (entry === own || !entry.startsWith(PREFIX) || !entry.endsWith(SUFFIX))
      continue;
    const file = opmEntry(entry);
    if (abandonedFiles?.has(entry) === true) {
      await removeChild(dir, entry, { force: true });
      removed.push({ file });
      continue;
    }
    const judged = await judge(dir, entry, abandoned);
    if (judged === 'gone') continue;
    if (judged.dead) {
      await removeChild(dir, entry, { force: true });
      if (judged.owner !== undefined)
        removed.push({ file, owner: judged.owner });
      continue;
    }
    holders.push({
      file,
      ...(!(judged.owner === undefined) && { owner: judged.owner }),
    });
  }
  return holders;
}

/** What a lock file says: its owner, if it can be read, and whether that owner is gone. */
type Judged = { owner?: ProcessOwner; dead: boolean } | 'gone';

async function judge(
  dir: FileHandle,
  entry: string,
  abandoned: ((owner: ProcessOwner) => boolean) | undefined,
): Promise<Judged> {
  try {
    const info = await lstatChild(dir, entry);
    if (!info.isFile()) return { dead: false };
    let owner: ProcessOwner | undefined;
    try {
      // SAFETY: parsed below; anything unexpected is a holder not judged.
      const record = JSON.parse(
        await readStableFileAt(dir, entry, LOCK_FILE_BYTES),
      ) as { lockVersion?: unknown; owner?: unknown };
      if (record.lockVersion === 1) owner = parseProcessOwner(record.owner);
    } catch (error) {
      // SAFETY: only the errno code of a file-system error is read.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'gone';
    }
    if (owner === undefined)
      // Created and not yet written, or written by something else: only a
      // file that has stayed empty or unreadable for a while is a leftover.
      return {
        dead:
          info.size === 0n &&
          Date.now() - Number(info.mtimeMs) > PARTIAL_AFTER_MS,
      };
    const dead = abandoned?.(owner) === true || !(await isOwnerAlive(owner));
    return { owner, dead };
  } catch (error) {
    // SAFETY: only the errno code of a file-system error is read.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'gone';
    throw error;
  }
}

function busy(holder: StepLockHolder): OpmError {
  const id = stepLockId(holder.file);
  const who =
    holder.owner === undefined
      ? `a lock opm cannot read (${holder.file})`
      : `${describeProcessOwner(holder.owner)} (${holder.file})`;
  return new OpmError(
    'PROJECT_BUSY',
    `Another opm step is changing this project: ${who}. Run this again when it has finished (--wait <ms> waits longer). If that step is dead and cannot be seen from here (another container or host), opm recover --abandon-step ${id ?? holder.file} says what taking it for dead costs and asks you to confirm.`,
  );
}
