import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  copyFile,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import { join } from 'node:path';
import {
  ensureStableDirectory,
  projectPaths,
  writeStableFile,
} from './paths.js';
import { currentProcessOwner } from './process-owner.js';
import {
  DISCARD_SUFFIX,
  LOCK_INDEX,
  MANIFEST_INDEX,
  ROLLBACK_FILES,
  ROLLBACK_PREFIX,
  ROLLBACK_RECORD,
  ROLLBACK_TREES,
  sha256,
  type KeptFile,
  type RollbackRecord,
} from './rollback-record.js';

/**
 * What an install changes once it starts linking, kept so a failure part way
 * puts it back: `opm add`, `opm sync` and `opm update` either finish or leave
 * the project as it was.
 *
 * Every write the install makes after its packages are in the store replaces a
 * name rather than writing into a file that is already there: a package's
 * directory is staged and renamed over the old one, its files are hard links to
 * the store, and shims, records and state are written to a temporary name and
 * renamed. So a copy of a tree whose files are hard links to the same inodes
 * still holds the old tree after the install has replaced every name in it, and
 * costs one link per file, not the bytes. Small files are copied outright.
 *
 * The copy is on disk, with a record of whose it is (`rollback.json`,
 * `rollback-record.ts`), so a process killed before it could put the project
 * back or discard the copy leaves enough for the next step to do it
 * (`rollback-recovery.ts`). It is taken inside a step (`project-step.ts`), so
 * no other step runs on the project while it exists.
 */

/** Not defined where links cannot be refused by `open` (Windows). */
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;

export interface ProjectSnapshot {
  /** Put every file and tree back as it was when the snapshot was taken. */
  restore(): Promise<void>;
  /** The install finished: drop the copy. */
  discard(): Promise<void>;
}

/** What the step is about to write first, so recovery knows it when it sees it. */
export interface IntendedWrites {
  manifest?: string | Uint8Array;
  lock?: string | Uint8Array;
}

export async function snapshotProject(
  root: string,
  intended: IntendedWrites = {},
): Promise<ProjectSnapshot> {
  const paths = projectPaths(root);
  const owner = await currentProcessOwner();
  await ensureStableDirectory(paths.opmDir);
  const holder = join(
    paths.opmDir,
    `${ROLLBACK_PREFIX}${owner.pid}-${randomUUID()}`,
  );
  const record: RollbackRecord = {
    rollbackVersion: 1,
    state: 'copying',
    owner,
    files: [],
    trees: [],
  };
  try {
    await mkdir(holder);
    await writeRecord(holder, record);
    await mkdir(join(holder, 'files'));
    await mkdir(join(holder, 'trees'));
    const after = new Map<number, string | Uint8Array>();
    if (intended.manifest !== undefined)
      after.set(MANIFEST_INDEX, intended.manifest);
    if (intended.lock !== undefined) after.set(LOCK_INDEX, intended.lock);
    const files: KeptFile[] = [];
    for (const [index, file] of ROLLBACK_FILES.entries())
      files.push(
        await keepFile(
          join(paths.root, file),
          join(holder, 'files', String(index)),
          after.get(index),
        ),
      );
    const trees: boolean[] = [];
    for (const [index, tree] of ROLLBACK_TREES.entries())
      trees.push(
        await keepTree(
          join(paths.root, tree.path),
          join(holder, 'trees', String(index)),
          tree.copy,
        ),
      );
    Object.assign(record, { state: 'ready', files, trees });
    await writeRecord(holder, record);
  } catch (error) {
    // A copy that could not be finished (a full disk, a file that cannot be
    // read) is no use to anyone: it goes now, not at the next step.
    await discardCopy(holder).catch(() => undefined);
    throw error;
  }
  return {
    restore: () => restoreFrom(paths.root, holder, record),
    discard: () => discardCopy(holder),
  };
}

async function keepFile(
  live: string,
  kept: string,
  intended: string | Uint8Array | undefined,
): Promise<KeptFile> {
  const after = intended === undefined ? {} : { after: sha256(intended) };
  const info = await lstat(live).catch(absent);
  const bytes = info === undefined ? undefined : await readFile(live);
  if (info === undefined || bytes === undefined)
    return { before: null, ...after };
  await writeFile(kept, bytes, { mode: 0o600 });
  return { before: sha256(bytes), mode: info.mode & 0o7777, ...after };
}

/**
 * Put the project back from a `ready` copy, then remove the copy. Every path
 * comes from the tables, never from the record. Safe to run again after it
 * was itself interrupted: a tree already moved back is skipped, and files are
 * rewritten whole.
 */
export async function restoreFrom(
  root: string,
  holder: string,
  record: RollbackRecord,
): Promise<void> {
  for (const [index, tree] of ROLLBACK_TREES.entries()) {
    const live = join(root, tree.path);
    const kept = join(holder, 'trees', String(index));
    if (record.trees[index] !== true)
      await rm(live, { recursive: true, force: true });
    else if ((await lstat(kept).catch(absent)) !== undefined) {
      await rm(live, { recursive: true, force: true });
      await rename(kept, live);
    }
  }
  for (const [index, file] of ROLLBACK_FILES.entries()) {
    const path = join(root, file);
    const kept = record.files[index];
    if (kept === undefined || kept.before === null)
      await rm(path, { force: true });
    else
      await putBack(
        path,
        await readFile(join(holder, 'files', String(index))),
        kept.mode ?? 0o644,
      );
  }
  await discardCopy(holder);
}

/**
 * Write a kept file back over `path` in place, never through a link: a link
 * where the file was is removed and the file made anew. In place, so that a
 * putting back that is itself killed leaves no temporary file behind; the
 * next one writes the file whole again.
 */
async function putBack(path: string, bytes: Buffer, mode: number) {
  const write = constants.O_WRONLY | constants.O_CREAT | NO_FOLLOW;
  let file: FileHandle;
  try {
    file = await open(path, write | constants.O_TRUNC, mode);
  } catch (error) {
    // SAFETY: only the errno code of a file-system error is read.
    if ((error as NodeJS.ErrnoException).code !== 'ELOOP') throw error;
    await rm(path);
    file = await open(path, write | constants.O_EXCL, mode);
  }
  try {
    await file.writeFile(bytes);
    await file.chmod(mode);
  } finally {
    await file.close();
  }
}

/**
 * Remove a copy. It is renamed first, so a copy half removed is never taken
 * for one to restore from.
 */
export async function discardCopy(holder: string): Promise<void> {
  const gone = holder.endsWith(DISCARD_SUFFIX)
    ? holder
    : `${holder}${DISCARD_SUFFIX}`;
  if (gone !== holder) await rename(holder, gone).catch(absent);
  await rm(gone, { recursive: true, force: true });
}

async function writeRecord(holder: string, record: RollbackRecord) {
  await writeStableFile(
    join(holder, ROLLBACK_RECORD),
    `${JSON.stringify(record, null, 2)}\n`,
  );
}

/** `undefined` for a path that does not exist; anything else is thrown. */
export function absent(error: NodeJS.ErrnoException): undefined {
  if (error.code === 'ENOENT') return undefined;
  throw error;
}

/**
 * `target` as a tree of hard links to `source`'s files (copies with `copy`),
 * its symbolic links recreated and never followed. False when there is no
 * `source`.
 */
async function keepTree(
  source: string,
  target: string,
  copy: boolean,
): Promise<boolean> {
  const info = await lstat(source).catch(absent);
  if (info === undefined) return false;
  if (info.isSymbolicLink()) await symlink(await readlink(source), target);
  else if (info.isDirectory()) {
    await mkdir(target, { mode: info.mode & 0o7777 });
    for (const name of await readdir(source))
      await keepTree(join(source, name), join(target, name), copy);
  } else if (copy) await copyFile(source, target);
  else
    await link(source, target).catch(async (error: unknown) => {
      // SAFETY: only the errno code of a file-system error is read.
      const code = (error as NodeJS.ErrnoException).code;
      // A file system that cannot link here still gets a faithful copy.
      if (code !== 'EXDEV' && code !== 'EPERM' && code !== 'EMLINK')
        throw error;
      await copyFile(source, target);
    });
  return true;
}
