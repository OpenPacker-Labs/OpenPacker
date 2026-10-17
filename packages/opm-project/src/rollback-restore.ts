import {
  chmod,
  cp,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  symlink,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import {
  absent,
  cannotPutBack,
  discardCopy,
  isMountError,
  putFileBack,
  putLinkBack,
  readKept,
  refuse,
} from './rollback-files.js';
import {
  ROLLBACK_FILES,
  ROLLBACK_TREES,
  type RollbackRecord,
} from './rollback-record.js';
import { OpmError } from './types.js';

/**
 * Put the project back from a `ready` copy, then remove the copy.
 *
 * Nothing is trusted and nothing is changed until all of it checks: every
 * path comes from the tables, never from the record; every kept file is read
 * from a no-follow handle, must have no other name, and must hash to what the
 * record says; a kept tree must be a directory (a link is put back as a link,
 * from the record, not from the copy); and no project file may have become a
 * directory. Any failure stops with nothing written (`UNSAFE_PATH`, or
 * `ROLLBACK_CONFLICT` for bytes that are not the recorded ones). Then trees
 * and files are put back; safe to run again after it was itself interrupted:
 * a tree is marked (`trees/<i>.moving`) before the first thing is done to it,
 * and a kept tree that is gone with its mark is one already moved back, while
 * one that is gone without is a copy that lost it and is refused. A file or a
 * tree the file system refuses is a plain `UNAVAILABLE` naming it.
 */
export async function restoreFrom(
  root: string,
  holder: string,
  record: RollbackRecord,
): Promise<void> {
  const steps: { name: string; run: () => Promise<void> }[] = [];
  for (const [index, tree] of ROLLBACK_TREES.entries()) {
    const live = join(root, tree.path);
    const kept = join(holder, 'trees', String(index));
    const row = record.trees[index];
    if (row === undefined || row === false)
      steps.push({
        name: tree.path,
        run: () => rm(live, { recursive: true, force: true }),
      });
    else if (row === true) {
      const info = await lstat(kept).catch(absent);
      if (info === undefined) {
        // Moved back by a putting back that was interrupted, or never there.
        if (await marked(markerOf(holder, 'trees', index, 'moving'))) continue;
        throw refuse(
          'ROLLBACK_CONFLICT',
          holder,
          `${tree.path} is missing from the copy`,
        );
      }
      if (!info.isDirectory())
        throw refuse(
          'UNSAFE_PATH',
          holder,
          `${tree.path} in the copy is not a directory`,
        );
      steps.push({
        name: tree.path,
        run: async () => {
          await mark(markerOf(holder, 'trees', index, 'moving'));
          await putTreeBack(live, kept);
        },
      });
    } else
      steps.push({
        name: tree.path,
        run: async () => {
          await rm(live, { recursive: true, force: true });
          await symlink(row, live);
        },
      });
  }
  for (const [index, name] of ROLLBACK_FILES.entries()) {
    const path = join(root, name);
    const row = record.files[index];
    if ((await lstat(path).catch(absent))?.isDirectory() === true)
      throw refuse('ROLLBACK_CONFLICT', holder, `${name} is a directory now`);
    if (row === undefined || row.before === null)
      steps.push({ name, run: () => rm(path, { force: true }) });
    else if (row.link !== undefined) {
      const target = row.link;
      steps.push({ name, run: () => putLinkBack(path, target) });
    } else {
      const bytes = await readKept(
        join(holder, 'files', String(index)),
        row.before,
        holder,
        name,
      );
      steps.push({
        name,
        run: () =>
          putFileBack(path, bytes, row.mode ?? 0o644, () =>
            mark(markerOf(holder, 'files', index, 'putting')),
          ),
      });
    }
  }
  for (const step of steps)
    try {
      await step.run();
    } catch (error) {
      throw error instanceof OpmError
        ? error
        : cannotPutBack(
            step.name,
            holder,
            error instanceof Error ? error : new Error(String(error)),
          );
    }
  await discardCopy(holder);
}

/**
 * A tree back at `live`: the copy renamed over it. Where `live` is a mount
 * point (a volume over node_modules) it cannot be removed, and the copy is on
 * another file system than it, so the directory stays and its contents are
 * replaced by the copy's, which stays whole until they are all in place.
 */
async function putTreeBack(live: string, kept: string): Promise<void> {
  try {
    await rm(live, { recursive: true, force: true });
    await rename(kept, live);
    return;
  } catch (error) {
    if (!(error instanceof Error && isMountError(error))) throw error;
  }
  const { mode } = await lstat(kept);
  await mkdir(live, { recursive: true, mode: mode & 0o7777 });
  for (const entry of await readdir(live))
    await rm(join(live, entry), { recursive: true, force: true });
  for (const entry of await readdir(kept))
    await cp(join(kept, entry), join(live, entry), {
      recursive: true,
      verbatimSymlinks: true,
      preserveTimestamps: true,
    });
  // The mount may not let this process change the mode; the contents are the point.
  await chmod(live, mode & 0o7777).catch(() => undefined);
  await rm(kept, { recursive: true, force: true });
}

/** Where the mark of what was begun on tree or file `index` is kept, in the copy. */
export const markerOf = (
  holder: string,
  kind: 'files' | 'trees',
  index: number,
  how: 'moving' | 'putting',
): string => join(holder, kind, `${index}.${how}`);

/** Say, durably, that this has been begun: a later run does not take half of it for the whole. */
async function mark(path: string): Promise<void> {
  const file = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}

export async function marked(path: string): Promise<boolean> {
  return (await lstat(path).catch(absent)) !== undefined;
}
