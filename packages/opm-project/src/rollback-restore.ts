import { lstat, rename, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
  absent,
  discardCopy,
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
 * a tree already moved back is skipped, and files are written whole.
 */
export async function restoreFrom(
  root: string,
  holder: string,
  record: RollbackRecord,
): Promise<void> {
  const steps: (() => Promise<void>)[] = [];
  for (const [index, tree] of ROLLBACK_TREES.entries()) {
    const live = join(root, tree.path);
    const kept = join(holder, 'trees', String(index));
    const row = record.trees[index];
    if (row === undefined || row === false)
      steps.push(() => rm(live, { recursive: true, force: true }));
    else if (row === true) {
      const info = await lstat(kept).catch(absent);
      // Already moved back by a putting back that was interrupted.
      if (info === undefined) continue;
      if (!info.isDirectory())
        throw refuse(
          'UNSAFE_PATH',
          holder,
          `${tree.path} in the copy is not a directory`,
        );
      steps.push(async () => {
        await rm(live, { recursive: true, force: true });
        await rename(kept, live);
      });
    } else
      steps.push(async () => {
        await rm(live, { recursive: true, force: true });
        await symlink(row, live);
      });
  }
  for (const [index, name] of ROLLBACK_FILES.entries()) {
    const path = join(root, name);
    const row = record.files[index];
    if ((await lstat(path).catch(absent))?.isDirectory() === true)
      throw refuse('ROLLBACK_CONFLICT', holder, `${name} is a directory now`);
    if (row === undefined || row.before === null)
      steps.push(() => rm(path, { force: true }));
    else if (row.link !== undefined) {
      const target = row.link;
      steps.push(() => putLinkBack(path, target));
    } else {
      const bytes = await readKept(
        join(holder, 'files', String(index)),
        row.before,
        holder,
        name,
      );
      steps.push(() => putFileBack(path, bytes, row.mode ?? 0o644));
    }
  }
  for (const step of steps) await step();
  await discardCopy(holder);
}
