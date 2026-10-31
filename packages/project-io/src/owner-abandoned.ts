import { constants } from 'node:fs';
import { lstat, type FileHandle } from 'node:fs/promises';
import { O_DIRECTORY, openChild } from './handle-path.js';
import {
  ownerFileProblem,
  readOwnerFile,
  readOwnerFileAt,
  type OwnerFileRead,
} from './owner-file.js';
import {
  isOwnerAlive,
  type OwnerProbe,
  type ProcessOwner,
} from './process-owner.js';

/**
 * Whether a directory that holds its owner in `.owner` (`owner-file.ts`) was
 * left by a process that has ended: the one judgement of every such holder (a
 * run's scratch, a sandbox's jail home), by the one rule (`process-owner.ts`).
 *
 * - An owner that may still be running, or that runs on another machine, in
 *   another PID namespace or anywhere it cannot be placed, is never abandoned.
 * - An owner file that says nothing opm can read (cut short, a newer version,
 *   a link) is judged by nobody: never abandoned.
 * - A directory with no owner file was made by a process cut short before it
 *   wrote one, or by an opm that wrote none; it is abandoned once it has not
 *   changed for `unownedAfterMs`, which each holder chooses.
 */

/** How an owner is judged; each part replaceable in a test. */
export interface AbandonJudge {
  /** The process judging; this one by default. */
  reader?: ProcessOwner;
  /** The system it asks about a pid. */
  probe?: OwnerProbe;
  /** The time now, for a directory with no owner file. */
  now?: () => number;
}

/** Whether `path` was left by a process that has ended: see the header. */
export async function abandonedByOwner(
  path: string,
  unownedAfterMs: number,
  judge: AbandonJudge = {},
): Promise<boolean> {
  const owner = await readOwnerFile(path);
  const read: OwnerFileRead =
    owner !== undefined
      ? { owner }
      : { problem: (await ownerFileProblem(path)) ?? 'unreadable' };
  const info = await lstat(path).catch(() => undefined);
  return await judged(
    read,
    info?.isDirectory() === true ? info.mtimeMs : undefined,
    unownedAfterMs,
    judge,
  );
}

/**
 * {@link abandonedByOwner} for the entry `name` of the directory `parent` is a
 * handle of, judged through a handle of it opened without following a link:
 * a link, or anything not a directory, is never abandoned, and a directory
 * swapped in after it was listed is judged as what is opened, not by a path.
 */
export async function abandonedByOwnerAt(
  parent: FileHandle,
  name: string,
  unownedAfterMs: number,
  judge: AbandonJudge = {},
): Promise<boolean> {
  const dir = await openChild(
    parent,
    name,
    constants.O_RDONLY | O_DIRECTORY | (constants.O_NOFOLLOW ?? 0),
  ).catch(() => undefined);
  if (dir === undefined) return false;
  try {
    const info = await dir.stat();
    if (!info.isDirectory()) return false;
    return await judged(
      await readOwnerFileAt(dir),
      info.mtimeMs,
      unownedAfterMs,
      judge,
    );
  } finally {
    await dir.close().catch(() => undefined);
  }
}

async function judged(
  read: OwnerFileRead,
  mtimeMs: number | undefined,
  unownedAfterMs: number,
  judge: AbandonJudge,
): Promise<boolean> {
  if ('owner' in read)
    return !(await isOwnerAlive(read.owner, judge.reader, judge.probe));
  // An owner file that says nothing opm can read is judged by nobody.
  if (read.problem !== 'missing') return false;
  return (
    mtimeMs !== undefined &&
    (judge.now ?? Date.now)() - mtimeMs > unownedAfterMs
  );
}
