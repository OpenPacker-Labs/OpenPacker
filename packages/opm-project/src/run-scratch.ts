import { randomUUID } from 'node:crypto';
import { mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { abandonedByOwner, type AbandonJudge } from '@openpacker/project-io';
import { writeOwnerFile } from './owner-file.js';
import { removeStableTree } from './paths.js';
import type { ProcessOwner } from './process-owner.js';
import { ensurePrivateRoot } from './shared-store-root.js';

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
export type Judge = AbandonJudge;

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
    if (!(await abandonedByOwner(path, UNOWNED_AFTER_MS, judge))) continue;
    await removeStableTree(path).catch(() => undefined);
  }
}

/** The directory of this user's under the temporary directory for what a project cannot hold. */
export const TEMPORARY_RUNS = 'openpacker-runs';

/** Why a scratch directory cannot be made where it belongs: this user may not write there. */
const UNWRITABLE = new Set(['EACCES', 'EPERM', 'EROFS']);

/** Whether `error` says this user may not write where it was making something. */
export function cannotMake(error: Error): boolean {
  return (
    'code' in error &&
    typeof error.code === 'string' &&
    UNWRITABLE.has(error.code)
  );
}

/**
 * A scratch directory in `openpacker-runs` under the temporary directory, for
 * a run whose project this user may read and not write (a read-only mount, a
 * CI cache, another user's checkout): that directory must be theirs and
 * private (mode 700) or nothing is made, and the runs that ended left there
 * are removed first, as where it belongs.
 */
export async function makeTemporaryScratch(
  prefix: string,
  owner?: ProcessOwner,
): Promise<Scratch> {
  const own = join(tmpdir(), TEMPORARY_RUNS);
  await ensurePrivateRoot(own, false, true, 'The temporary runs directory');
  await sweepAbandoned(own, prefix);
  return await makeScratch(own, prefix, owner);
}
