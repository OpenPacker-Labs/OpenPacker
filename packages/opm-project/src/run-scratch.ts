import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ownerFileProblem,
  readOwnerFile,
  writeOwnerFile,
} from './owner-file.js';
import { removeStableTree } from './paths.js';
import {
  isOwnerAlive,
  type OwnerProbe,
  type ProcessOwner,
} from './process-owner.js';

/**
 * Directories a run makes for itself and removes when it ends: the store views
 * a sandbox binds, and the `node_modules` an ephemeral tool runs from.
 *
 * A run killed outright (SIGKILL, a crash, the power) never reaches the code
 * that removes them. So each is a directory `<prefix><uuid>` that holds who
 * made it, in `.owner` (`owner-file.ts`), written as soon as the directory is
 * made, and what the run uses in `tree`, the one thing a sandbox binds: the
 * owner is never in what a tool can see. The next run that makes one in the
 * same place, and `opm gc` for views, removes those whose owner has ended, by
 * the one rule opm judges every holder by (`process-owner.ts`). One whose
 * owner may still be running is never touched, nor one another machine or PID
 * namespace made. One this machine made in an earlier boot is removed whatever
 * its pid where the machine id says it is this machine; with no machine id it
 * is kept. Off Linux nothing but the host name and the pid is read, so those
 * two decide, whichever boot made it.
 */

/** What a run made: the directory it removes, and the tree inside it it uses. */
export interface Scratch {
  /** `<dir>/<prefix><uuid>`: `.owner` and `tree`. */
  path: string;
  /** `<path>/tree`, empty when made. */
  tree: string;
}

/** The directory inside a scratch directory that a run uses. */
const TREE = 'tree';

/**
 * How long a scratch directory with no `.owner` is left alone: one is written
 * as soon as the directory is made, so one still without it this long after
 * was made by a run cut short in between, which is how an empty step lock is
 * judged. Waiting longer costs nothing but the directory.
 */
export const UNOWNED_AFTER_MS = 60_000;

/**
 * Make a scratch directory under `dir` that this process owns (or `owner`,
 * for a test). Nothing is left behind when it cannot be made whole.
 */
export async function makeScratch(
  dir: string,
  prefix: string,
  owner?: ProcessOwner,
): Promise<Scratch> {
  const path = join(dir, `${prefix}${randomUUID()}`);
  await mkdir(path, { mode: 0o755 });
  const tree = join(path, TREE);
  try {
    await writeOwnerFile(path, owner);
    await mkdir(tree, { mode: 0o755 });
  } catch (error) {
    await removeStableTree(path).catch(() => undefined);
    throw error;
  }
  return { path, tree };
}

/** How `sweepAbandoned` judges an owner; replaceable in a test. */
export interface Judge {
  /** The process judging; this one by default. */
  reader?: ProcessOwner;
  /** The system it asks about a pid. */
  probe?: OwnerProbe;
  /** The time now, for a directory with no owner yet. */
  now?: () => number;
}

/** Whether what `path` holds was left by a run that has ended. */
async function abandoned(path: string, judge: Judge): Promise<boolean> {
  const owner = await readOwnerFile(path);
  if (owner !== undefined)
    return !(await isOwnerAlive(owner, judge.reader, judge.probe));
  // An owner file that says nothing opm can read is judged by nobody.
  if ((await ownerFileProblem(path)) !== 'missing') return false;
  const info = await lstat(path).catch(() => undefined);
  return (
    info?.isDirectory() === true &&
    (judge.now ?? Date.now)() - info.mtimeMs > UNOWNED_AFTER_MS
  );
}

/** Remove what runs that have ended left under `prefix` in `dir`. */
export async function sweepAbandoned(
  dir: string,
  prefix: string,
  judge: Judge = {},
): Promise<void> {
  const names = await readdir(dir).catch(() => []);
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const path = join(dir, name);
    if (!(await abandoned(path, judge))) continue;
    await removeStableTree(path).catch(() => undefined);
  }
}
