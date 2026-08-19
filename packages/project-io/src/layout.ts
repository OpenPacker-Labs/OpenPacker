/**
 * Materialise a directory from the content-addressed store.
 *
 * Copy through stable, no-follow file and directory handles, and never
 * symlink. Pathname-only hardlinks would reopen the source race this boundary
 * exists to close.
 */

import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  copyFile,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  stat,
  type FileHandle,
} from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { ProjectIoError } from './index.js';

export interface MaterialiseResult {
  /** Files linked or copied. */
  files: number;
  /** True when at least one file had to be copied rather than linked. */
  copied: boolean;
}

/**
 * Replace `destination` with the contents of `source`.
 *
 * Replace, not merge: a layout that accumulates files from a previous
 * resolution is a layout nobody can reason about.
 */
export async function materialiseTree(
  source: string,
  destination: string,
  root: string,
): Promise<MaterialiseResult> {
  assertContained(root, destination);
  const rootHandle = await openDirectory(root, true);
  const handles: FileHandle[] = [rootHandle];
  const result: MaterialiseResult = { files: 0, copied: false };
  let staging: string | undefined;
  try {
    const parts = relative(resolve(root), resolve(destination)).split(sep);
    const name = parts.pop();
    if (!name || name === '.' || name === '..') throw unsafe(destination);
    let parent = rootHandle;
    for (const part of parts) {
      if (!part || part === '.' || part === '..') throw unsafe(destination);
      const childPath = join(handlePath(parent), part);
      await mkdir(childPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
      });
      parent = await openDirectory(childPath, false);
      handles.push(parent);
    }

    const parentPath = handlePath(parent);
    staging = join(parentPath, `.${name}.openpacker-${randomUUID()}`);
    await mkdir(staging);
    const stagingHandle = await openDirectory(staging, false);
    handles.push(stagingHandle);
    const sourceHandle = await openDirectory(source, false);
    handles.push(sourceHandle);
    await walk(sourceHandle, stagingHandle, result);
    const published = join(parentPath, name);
    await rm(published, { recursive: true, force: true });
    await rename(staging, published);
    staging = undefined;
    return result;
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === 'ELOOP' ||
      (error as NodeJS.ErrnoException).code === 'ENOTDIR'
    )
      throw unsafe(destination);
    throw error;
  } finally {
    if (staging)
      await rm(staging, { recursive: true, force: true }).catch(
        () => undefined,
      );
    await Promise.all(
      handles.reverse().map(async (handle) => await handle.close()),
    );
  }
}

async function walk(
  source: FileHandle,
  destination: FileHandle,
  result: MaterialiseResult,
): Promise<void> {
  const sourcePath = handlePath(source);
  const destinationPath = handlePath(destination);
  const entries = await readdir(sourcePath, { withFileTypes: true });
  for (const entry of entries) {
    const from = join(sourcePath, entry.name);
    const to = join(destinationPath, entry.name);
    if (entry.isDirectory()) {
      const fromHandle = await openDirectory(from, false);
      await mkdir(to);
      const toHandle = await openDirectory(to, false);
      try {
        await walk(fromHandle, toHandle, result);
      } finally {
        await Promise.all([fromHandle.close(), toHandle.close()]);
      }
      continue;
    }
    if (!entry.isFile()) {
      // The store is built by the materializer, which already refuses
      // symlinks, devices and sockets. Anything else here is not something to
      // reproduce into a project directory on a guess.
      throw unsafe(from);
    }
    const file = await open(
      from,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
    try {
      const info = await file.stat();
      if (!info.isFile()) throw unsafe(from);
      await copyFile(handlePath(file), to, constants.COPYFILE_EXCL);
      await chmod(to, (info.mode & 0o111) !== 0 ? 0o755 : 0o644);
      result.copied = true;
    } finally {
      await file.close();
    }
    result.files += 1;
  }
}

async function openDirectory(
  path: string,
  create: boolean,
): Promise<FileHandle> {
  if (create)
    await mkdir(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
  try {
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    if (!(await handle.stat()).isDirectory()) {
      await handle.close();
      throw unsafe(path);
    }
    return handle;
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === 'ELOOP' ||
      (error as NodeJS.ErrnoException).code === 'ENOTDIR'
    )
      throw unsafe(path);
    throw error;
  }
}

function handlePath(handle: FileHandle): string {
  if (process.platform === 'linux') return `/proc/self/fd/${handle.fd}`;
  if (process.platform === 'darwin') return `/dev/fd/${handle.fd}`;
  throw new ProjectIoError(
    'UNSAFE_PATH',
    String(handle.fd),
    'Native layout requires stable no-follow directory handles on this platform',
  );
}

function unsafe(path: string): ProjectIoError {
  return new ProjectIoError(
    'UNSAFE_PATH',
    path,
    `Layout path is linked, special, or unstable: ${path}`,
  );
}

/**
 * Refuse a destination outside its root.
 *
 * The path is built from a package name that came off a registry, and what
 * happens next is a recursive delete followed by a write. `@evil/../../..` has
 * to stop here.
 */
function assertContained(root: string, destination: string): void {
  const base = resolve(root);
  const target = resolve(destination);
  if (target !== base && !target.startsWith(base + sep))
    throw new ProjectIoError(
      'UNSAFE_PATH',
      destination,
      `Layout destination escapes ${base}: ${destination}`,
    );
}

/** Remove a layout directory if it exists. */
export async function removeTree(path: string): Promise<void> {
  const parent = await openDirectory(dirname(resolve(path)), false);
  try {
    await rm(join(handlePath(parent), resolve(path).split(sep).at(-1)!), {
      recursive: true,
      force: true,
    });
  } finally {
    await parent.close();
  }
}

/** Every file under `root`, as archive entries with forward-slash paths. */
export async function collectFiles(
  root: string,
  prefix = '',
): Promise<{ path: string; contents: Uint8Array; executable: boolean }[]> {
  const out: {
    path: string;
    contents: Uint8Array;
    executable: boolean;
  }[] = [];
  const { readFile } = await import('node:fs/promises');
  const walkOne = async (directory: string, at: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const from = join(directory, entry.name);
      const path = at === '' ? entry.name : `${at}/${entry.name}`;
      if (entry.isDirectory()) {
        await walkOne(from, path);
        continue;
      }
      if (!entry.isFile()) continue;
      const info = await stat(from);
      out.push({
        path: prefix === '' ? path : `${prefix}/${path}`,
        contents: new Uint8Array(await readFile(from)),
        executable: (info.mode & 0o111) !== 0,
      });
    }
  };
  await walkOne(root, '');
  return out;
}
