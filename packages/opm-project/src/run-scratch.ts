import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { abandonedByOwner, type AbandonJudge } from '@openpacker/project-io';
import { writeOwnerFile } from './owner-file.js';
import { openStableDirectory, removeStableTree } from './paths.js';
import type { ProcessOwner } from './process-owner.js';
import { OpmError } from './types.js';

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

/**
 * This user's directory under the temporary directory for what a project it
 * may not write cannot hold: `openpacker-runs-<uid>`, one per user, so users
 * who share /tmp each have theirs; where there are no uids, the one name.
 */
export function temporaryRunsRoot(): string {
  const uid = process.geteuid?.();
  return join(
    tmpdir(),
    uid === undefined ? TEMPORARY_RUNS : `${TEMPORARY_RUNS}-${uid}`,
  );
}

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
 * Open `path`, a directory under the temporary directory, and refuse it unless
 * it is this user's and others may not write it; one of this user's that its
 * group may read or write (made under umask 002 or 022) is made 0700. The
 * checks and that change are made on the handle opened without following a
 * link. Made 0700 where `create` and it is not there.
 */
async function openTemporaryRoot(
  path: string,
  create: boolean,
): Promise<FileHandle> {
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  const handle = await openStableDirectory(path);
  try {
    if (process.platform === 'win32') return handle;
    const info = await handle.stat();
    const uid = process.geteuid?.();
    if (uid !== undefined && info.uid !== uid)
      throw new OpmError(
        'UNSAFE_PATH',
        `The temporary runs directory ${path} is owned by uid ${info.uid}, ` +
          `not by this user (uid ${uid}); remove it, or set TMPDIR to a ` +
          'directory of your own',
      );
    if ((info.mode & 0o002) !== 0)
      throw new OpmError(
        'UNSAFE_PATH',
        `The temporary runs directory ${path} can be written by others ` +
          `(mode ${(info.mode & 0o777).toString(8)}); it must be writable by ` +
          'its owner alone',
      );
    if ((info.mode & 0o077) !== 0) await handle.chmod(0o700);
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/**
 * A scratch directory in this user's `openpacker-runs-<uid>` under the
 * temporary directory, for a run whose project this user may read and not
 * write (a read-only mount, a CI cache, another user's checkout): that
 * directory must be theirs and others may not write it, or nothing is made.
 * What runs that ended left there is removed first, as where it belongs, and
 * so is what this user's ended runs left in the `openpacker-runs` all users
 * shared before, where that is this user's own; one another user made there is
 * left alone, and stops nothing.
 */
export async function makeTemporaryScratch(
  prefix: string,
  owner?: ProcessOwner,
): Promise<Scratch> {
  const own = temporaryRunsRoot();
  await (await openTemporaryRoot(own, true)).close();
  await sweepAbandoned(own, prefix);
  const shared = join(tmpdir(), TEMPORARY_RUNS);
  if (shared !== own && existsSync(shared)) {
    const held = await openTemporaryRoot(shared, false).catch(() => undefined);
    if (held !== undefined) {
      await held.close();
      await sweepAbandoned(shared, prefix);
    }
  }
  return await makeScratch(own, prefix, owner);
}
