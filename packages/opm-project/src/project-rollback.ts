import { randomUUID } from 'node:crypto';
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  readdir,
  readlink,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { ensureStableDirectory, projectPaths } from './paths.js';
import { currentOwner } from './process-owner.js';
import { absent, discardCopy, readLive } from './rollback-files.js';
import { journalWrites, writeRecord } from './rollback-journal.js';
import { projectIdentity } from './rollback-project.js';
import {
  LOCK_INDEX,
  MANIFEST_INDEX,
  ROLLBACK_FILES,
  ROLLBACK_PREFIX,
  ROLLBACK_TREES,
  linkDigest,
  sha256,
  type KeptFile,
  type KeptTree,
  type RollbackRecord,
} from './rollback-record.js';
import { restoreFrom } from './rollback-restore.js';

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

export interface ProjectSnapshot {
  /** Put every file and tree back as it was when the snapshot was taken. */
  restore(): Promise<void>;
  /** The install finished: drop the copy. */
  discard(): Promise<void>;
  /**
   * Tell the copy that `path` is about to hold `contents`, before it does
   * (`rollback-journal.ts`): package.json and package-lock.json only; any
   * other path is not the copy's business.
   */
  noteWrite(path: string, contents: string | Uint8Array): Promise<void>;
}

/**
 * What the step is about to write first, so recovery knows it when it sees it:
 * the bytes, or `'unchanged'` for a file the step leaves as it is (`opm sync`
 * does not write opm.toml, and a hand edit of it after a kill is not the
 * step's to undo).
 */
export interface IntendedWrites {
  manifest?: string | Uint8Array | 'unchanged';
  lock?: string | Uint8Array | 'unchanged';
}

export async function snapshotProject(
  root: string,
  intended: IntendedWrites = {},
): Promise<ProjectSnapshot> {
  const paths = projectPaths(root);
  const owner = await currentOwner();
  await ensureStableDirectory(paths.opmDir);
  const holder = join(
    paths.opmDir,
    `${ROLLBACK_PREFIX}${owner.pid}-${randomUUID()}`,
  );
  const record: RollbackRecord = {
    rollbackVersion: 1,
    state: 'copying',
    owner,
    project: await projectIdentity(paths.root),
    files: [],
    trees: [],
  };
  try {
    await mkdir(holder);
    await writeRecord(holder, record);
    await mkdir(join(holder, 'files'));
    await mkdir(join(holder, 'trees'));
    const after = new Map<number, string | Uint8Array | 'unchanged'>();
    if (intended.manifest !== undefined)
      after.set(MANIFEST_INDEX, intended.manifest);
    if (intended.lock !== undefined) after.set(LOCK_INDEX, intended.lock);
    const files: KeptFile[] = [];
    for (const [index, file] of ROLLBACK_FILES.entries())
      files.push(
        await keepFile(
          join(paths.root, file),
          join(holder, 'files', String(index)),
          file,
          after.get(index),
        ),
      );
    const trees: KeptTree[] = [];
    for (const [index, tree] of ROLLBACK_TREES.entries())
      trees.push(
        await keepRoot(
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
    noteWrite: journalWrites(paths.root, holder, record),
  };
}

async function keepFile(
  live: string,
  kept: string,
  name: string,
  intended: string | Uint8Array | 'unchanged' | undefined,
): Promise<KeptFile> {
  const current = await readLive(live, name);
  const row: KeptFile =
    current === undefined
      ? { before: null }
      : current.kind === 'link'
        ? { before: linkDigest(current.target), link: current.target }
        : { before: sha256(current.bytes), mode: current.mode };
  if (current?.kind === 'file')
    await writeFile(kept, current.bytes, { mode: 0o600 });
  const after =
    intended === 'unchanged'
      ? row.before
      : intended === undefined
        ? null
        : sha256(intended);
  return after === null ? row : { ...row, after };
}

/**
 * A tree of the project as the copy keeps it: `false` where there is none, a
 * link's target where the entry is a link (kept as what it says, never
 * followed: what is behind it is not the copy's to keep), `true` for a
 * directory, which is kept at `target`.
 */
async function keepRoot(
  source: string,
  target: string,
  copy: boolean,
): Promise<KeptTree> {
  const info = await lstat(source).catch(absent);
  if (info === undefined) return false;
  if (info.isSymbolicLink()) return readlink(source);
  return keepTree(source, target, copy);
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
    // Made private and given its mode last: `mkdir`'s mode goes through the
    // umask (a 1777 volume root came back 1755, a setgid directory lost its
    // bit), and a directory that is not writable could not be filled.
    await mkdir(target, { mode: 0o700 });
    for (const name of await readdir(source))
      await keepTree(join(source, name), join(target, name), copy);
    await chmod(target, info.mode & 0o7777);
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
