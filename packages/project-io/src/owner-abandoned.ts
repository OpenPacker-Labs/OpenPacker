import { lstat } from 'node:fs/promises';
import { ownerFileProblem, readOwnerFile } from './owner-file.js';
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
  if (owner !== undefined)
    return !(await isOwnerAlive(owner, judge.reader, judge.probe));
  if ((await ownerFileProblem(path)) !== 'missing') return false;
  const info = await lstat(path).catch(() => undefined);
  return (
    info?.isDirectory() === true &&
    (judge.now ?? Date.now)() - info.mtimeMs > unownedAfterMs
  );
}
