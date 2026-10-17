import { randomUUID } from 'node:crypto';
import {
  copyFile,
  link,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { ENVIRONMENT_STATE, GENERATIONS_DIR } from './generations.js';
import { NATIVE_STATE } from './native.js';
import { OPM_DIR, projectPaths, writeStableFile } from './paths.js';
import { currentOwner, type RollbackOwner } from './rollback-owner.js';

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
 * The copy is on disk, with a record of whose it is (`rollback.json`), so a
 * process killed before it could put the project back or discard the copy
 * leaves enough for the next step to do it (`rollback-recovery.ts`).
 */

/** Copies of a project are `.opm/.rollback-<pid>-<uuid>`. */
export const ROLLBACK_PREFIX = '.rollback-';
/** A copy being removed: never one to restore from. */
export const DISCARD_SUFFIX = '.discard';
export const ROLLBACK_RECORD = 'rollback.json';

/** Files an install may rewrite, relative to the project root. */
const FILES = [
  'opm.toml',
  'opm.lock.json',
  'package.json',
  'package-lock.json',
  join(OPM_DIR, 'project.json'),
  join(OPM_DIR, NATIVE_STATE),
  join(OPM_DIR, ENVIRONMENT_STATE),
] as const;

/**
 * Trees an install may change, relative to the project root. node_modules is
 * kept as hard links (its files are the store's); opm's own small trees are
 * copied, so nothing depends on how they are written.
 */
const TREES = [
  { path: 'node_modules', copy: false },
  { path: join(OPM_DIR, 'bin'), copy: true },
  { path: join(OPM_DIR, 'links'), copy: true },
  { path: join(OPM_DIR, GENERATIONS_DIR), copy: true },
] as const;

export interface RollbackRecord {
  rollbackVersion: 1;
  /** `copying` until every file and tree is kept: only `ready` restores. */
  state: 'copying' | 'ready';
  owner: RollbackOwner;
  files: { path: string; present: boolean }[];
  trees: { path: string; present: boolean }[];
}

export interface ProjectSnapshot {
  /** Put every file and tree back as it was when the snapshot was taken. */
  restore(): Promise<void>;
  /** The install finished: drop the copy. */
  discard(): Promise<void>;
}

export async function snapshotProject(root: string): Promise<ProjectSnapshot> {
  const paths = projectPaths(root);
  const owner = await currentOwner();
  const holder = join(
    paths.opmDir,
    `${ROLLBACK_PREFIX}${owner.pid}-${randomUUID()}`,
  );
  await mkdir(join(holder, 'files'), { recursive: true });
  await mkdir(join(holder, 'trees'));
  const record: RollbackRecord = {
    rollbackVersion: 1,
    state: 'copying',
    owner,
    files: [],
    trees: [],
  };
  await writeRecord(holder, record);
  for (const [index, file] of FILES.entries()) {
    const bytes = await readFile(join(paths.root, file)).catch(absent);
    if (bytes !== undefined)
      await writeFile(join(holder, 'files', String(index)), bytes);
    record.files.push({ path: file, present: bytes !== undefined });
  }
  for (const [index, tree] of TREES.entries())
    record.trees.push({
      path: tree.path,
      present: await keepTree(
        join(paths.root, tree.path),
        join(holder, 'trees', String(index)),
        tree.copy,
      ),
    });
  record.state = 'ready';
  await writeRecord(holder, record);
  return {
    restore: () => restoreFrom(paths.root, holder, record),
    discard: () => discardCopy(holder),
  };
}

/**
 * Put the project back from a `ready` copy, then remove the copy. Safe to run
 * again after it was itself interrupted: a tree already moved back is skipped,
 * and files are rewritten whole.
 */
export async function restoreFrom(
  root: string,
  holder: string,
  record: RollbackRecord,
): Promise<void> {
  for (const [index, tree] of record.trees.entries()) {
    const live = join(root, tree.path);
    const kept = join(holder, 'trees', String(index));
    if (!tree.present) await rm(live, { recursive: true, force: true });
    else if ((await lstat(kept).catch(absent)) !== undefined) {
      await rm(live, { recursive: true, force: true });
      await rename(kept, live);
    }
  }
  for (const [index, file] of record.files.entries()) {
    const path = join(root, file.path);
    if (!file.present) await rm(path, { force: true });
    else
      await writeFile(
        path,
        await readFile(join(holder, 'files', String(index))),
      );
  }
  await discardCopy(holder);
}

/**
 * Remove a copy. It is renamed first, so a copy half removed is never taken
 * for one to restore from.
 */
export async function discardCopy(holder: string): Promise<void> {
  const gone = holder.endsWith(DISCARD_SUFFIX)
    ? holder
    : `${holder}${DISCARD_SUFFIX}`;
  if (gone !== holder)
    await rename(holder, gone).catch((error: unknown) => {
      if (absent(error) === undefined) return;
      throw error;
    });
  await rm(gone, { recursive: true, force: true });
}

async function writeRecord(holder: string, record: RollbackRecord) {
  await writeStableFile(
    join(holder, ROLLBACK_RECORD),
    `${JSON.stringify(record, null, 2)}\n`,
  );
}

/** `undefined` for a path that does not exist; anything else is thrown. */
function absent(error: unknown): undefined {
  // SAFETY: only the errno code of a file-system error is read.
  if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
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
