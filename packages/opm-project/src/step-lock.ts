import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, rmdir, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { lstatChild } from '@openpacker/project-io';
import {
  openChild,
  openStableDirectory,
  readDirChild,
  readStableFileAt,
  removeChild,
  type ProjectPaths,
} from './paths.js';
import {
  currentProcessOwner,
  describeProcessOwner,
  parseProcessOwner,
  processOwnerMayBeAlive,
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
  /** `.opm/step-<uuid>.lock`, relative to the project root. */
  file: string;
  /** Who holds it; absent when the file cannot be read as a lock. */
  owner?: ProcessOwner;
}

export interface StepLock {
  release(): Promise<void>;
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
  },
): Promise<StepLock | undefined> {
  const root = await lstat(paths.root).catch(() => undefined);
  if (root === undefined || !root.isDirectory()) return undefined;
  const createdOpmDir =
    (await lstat(paths.opmDir).catch(() => undefined)) === undefined;
  const name = `${PREFIX}${randomUUID()}${SUFFIX}`;
  const body = `${JSON.stringify({
    lockVersion: 1,
    owner: await currentProcessOwner(),
  })}\n`;
  const deadline = Date.now() + options.waitMs;
  let told = false;
  for (;;) {
    const dir = await openStableDirectory(paths.opmDir, true);
    try {
      if (await createLockFile(dir, name, body)) {
        const holders = await liveHolders(dir, name);
        if (holders.length === 0) return held(paths, dir, name, createdOpmDir);
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

/** False when `.opm` went away under it (removed by a step that made it). */
async function createLockFile(
  dir: FileHandle,
  name: string,
  body: string,
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
    throw error;
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
): StepLock {
  let released = false;
  return {
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
): Promise<StepLockHolder[]> {
  const holders: StepLockHolder[] = [];
  for (const entry of (await readDirChild(dir)).sort()) {
    if (entry === own || !entry.startsWith(PREFIX) || !entry.endsWith(SUFFIX))
      continue;
    const file = join('.opm', entry);
    const judged = await judge(dir, entry);
    if (judged === 'gone') continue;
    if (judged === 'dead') {
      await removeChild(dir, entry, { force: true });
      continue;
    }
    holders.push({ file, ...(!(judged === 'unknown') && { owner: judged }) });
  }
  return holders;
}

async function judge(
  dir: FileHandle,
  entry: string,
): Promise<ProcessOwner | 'dead' | 'gone' | 'unknown'> {
  try {
    const info = await lstatChild(dir, entry);
    if (!info.isFile()) return 'unknown';
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
      return info.size === 0n &&
        Date.now() - Number(info.mtimeMs) > PARTIAL_AFTER_MS
        ? 'dead'
        : 'unknown';
    return (await processOwnerMayBeAlive(owner)) ? owner : 'dead';
  } catch (error) {
    // SAFETY: only the errno code of a file-system error is read.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'gone';
    throw error;
  }
}

function busy(holder: StepLockHolder): OpmError {
  const who =
    holder.owner === undefined
      ? `a lock opm cannot read (${holder.file})`
      : `${describeProcessOwner(holder.owner)} (${holder.file})`;
  return new OpmError(
    'PROJECT_BUSY',
    `Another opm step is changing this project: ${who}. Run this again when it has finished; if no opm is running there, remove ${holder.file}.`,
  );
}
