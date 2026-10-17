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
import { OPM_DIR, projectPaths } from './paths.js';

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
 */

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

export interface ProjectSnapshot {
  /** Put every file and tree back as it was when the snapshot was taken. */
  restore(): Promise<void>;
  /** The install finished: drop the copy. */
  discard(): Promise<void>;
}

export async function snapshotProject(root: string): Promise<ProjectSnapshot> {
  const paths = projectPaths(root);
  const holder = join(paths.opmDir, `.rollback-${randomUUID()}`);
  await mkdir(holder, { recursive: true });
  const files = new Map<string, Uint8Array | undefined>();
  for (const file of FILES)
    files.set(
      file,
      await readFile(join(paths.root, file)).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
          return undefined;
        throw error;
      }),
    );
  const kept: boolean[] = [];
  for (const [index, tree] of TREES.entries())
    kept[index] = await keepTree(
      join(paths.root, tree.path),
      join(holder, String(index)),
      tree.copy,
    );

  return {
    async restore() {
      for (const [index, tree] of TREES.entries()) {
        const live = join(paths.root, tree.path);
        await rm(live, { recursive: true, force: true });
        if (kept[index] === true)
          await rename(join(holder, String(index)), live);
      }
      for (const [file, bytes] of files) {
        const path = join(paths.root, file);
        if (bytes === undefined) await rm(path, { force: true });
        else await writeFile(path, bytes);
      }
      await rm(holder, { recursive: true, force: true });
    },
    async discard() {
      await rm(holder, { recursive: true, force: true });
    },
  };
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
  let info;
  try {
    info = await lstat(source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  if (info.isSymbolicLink()) await symlink(await readlink(source), target);
  else if (info.isDirectory()) {
    await mkdir(target, { mode: info.mode & 0o7777 });
    for (const name of await readdir(source))
      await keepTree(join(source, name), join(target, name), copy);
  } else if (copy) await copyFile(source, target);
  else
    await link(source, target).catch(async (error: unknown) => {
      const code = (error as NodeJS.ErrnoException).code;
      // A file system that cannot link here still gets a faithful copy.
      if (code !== 'EXDEV' && code !== 'EPERM' && code !== 'EMLINK')
        throw error;
      await copyFile(source, target);
    });
  return true;
}
