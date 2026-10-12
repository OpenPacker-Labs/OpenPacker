/**
 * Opening a directory by walking its path one no-follow handle at a time.
 *
 * Shared by the layout code that materialises a tree, the walkers that read
 * one, and the member-link code that places links by project path. Every
 * component is opened relative to the one before, with `O_NOFOLLOW`, so a
 * swapped ancestor cannot redirect anything below it.
 */

import { constants } from 'node:fs';
import { mkdir, open, realpath, type FileHandle } from 'node:fs/promises';
import {
  basename,
  dirname,
  join,
  parse,
  relative,
  resolve,
  sep,
} from 'node:path';
import { ProjectIoError } from './index.js';
import {
  O_DIRECTORY,
  lstatChild,
  mkdirChild,
  openChild,
  windowsReadReparse,
} from './handle-path.js';

/**
 * Canonicalize the existing ancestor prefix of a stable target.
 *
 * The no-follow component walk refuses symlinked path components, which would
 * reject every layout under a legitimately symlinked ancestor — macOS
 * `/var` → `/private/var` (all of `$TMPDIR`), symlinked home directories,
 * automounters. Honor such a stable pre-existing prefix once by realpath-ing
 * the deepest existing ancestor here; the final component stays lexical so a
 * symlinked target itself is still refused, and all subsequent traversal is
 * fd-relative, so a later swap of the prefix cannot redirect anything.
 */
async function canonicalizeStableTarget(path: string): Promise<string> {
  const absolute = resolve(path);
  const tail: string[] = [basename(absolute)];
  let candidate = dirname(absolute);
  for (;;) {
    try {
      const canonical = await realpath(candidate);
      return join(canonical, ...tail.reverse());
    } catch (error) {
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ELOOP' || code === 'ENOTDIR') throw unsafe(path);
      if (code !== 'ENOENT') throw error;
    }
    const parent = dirname(candidate);
    if (parent === candidate) return absolute;
    tail.push(basename(candidate));
    candidate = parent;
  }
}

export async function openProjectDirectory(
  path: string,
  create: boolean,
): Promise<FileHandle> {
  const absolute = await canonicalizeStableTarget(path);
  const root = parse(absolute).root;
  let handle = await openDirectory(root, false);
  try {
    for (const part of relative(root, absolute).split(sep).filter(Boolean)) {
      if (create)
        await mkdirChild(handle, part).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'EEXIST') throw error;
        });
      const next = await openDirectoryAt(handle, part);
      await handle.close();
      handle = next;
    }
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    if (
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      (error as NodeJS.ErrnoException).code === 'ELOOP' ||
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      (error as NodeJS.ErrnoException).code === 'ENOTDIR' ||
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    )
      throw unsafe(path);
    throw error;
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
      constants.O_RDONLY | O_DIRECTORY | constants.O_NOFOLLOW,
    );
    if (!(await handle.stat()).isDirectory()) {
      await handle.close();
      throw unsafe(path);
    }
    return handle;
  } catch (error) {
    if (
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      (error as NodeJS.ErrnoException).code === 'ELOOP' ||
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      (error as NodeJS.ErrnoException).code === 'ENOTDIR' ||
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    )
      throw unsafe(path);
    throw error;
  }
}

export async function openDirectoryAt(
  parent: FileHandle,
  name: string,
): Promise<FileHandle> {
  const handle = await openChild(
    parent,
    name,
    constants.O_RDONLY | O_DIRECTORY | constants.O_NOFOLLOW,
  );
  if (!(await handle.stat()).isDirectory()) {
    await handle.close();
    throw unsafe(name);
  }
  return handle;
}

export function unsafe(path: string): ProjectIoError {
  return new ProjectIoError(
    'UNSAFE_PATH',
    path,
    `Layout path is linked, special, or unstable: ${path}`,
  );
}

/** What one step down a path found, without following anything. */
export type PlainStep =
  | { kind: 'directory'; handle: FileHandle }
  | { kind: 'missing' | 'link' | 'other' };

/**
 * Open the child directory `name` of `parent` and say what it is: a plain
 * directory (a handle on it), nothing at all, a link, or something that is not
 * a directory. A link is a symbolic link, or on Windows any reparse point:
 * Windows opens a junction as itself and not as what it points at, so that open
 * succeeds and says "directory", and what a junction is comes from its reparse
 * data (`FSCTL_GET_REPARSE_POINT`), not from what NT would then do inside it.
 */
export async function stepPlainDirectory(
  parent: FileHandle,
  name: string,
): Promise<PlainStep> {
  let next: FileHandle;
  try {
    next = await openChild(
      parent,
      name,
      constants.O_RDONLY | O_DIRECTORY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    // SAFETY: the operations above throw Error values with an optional errno code.
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { kind: 'missing' };
    if (code !== 'ELOOP' && code !== 'ENOTDIR') throw error;
    // Refused for being a link, or for not being a directory: one lstat says which.
    try {
      const info = await lstatChild(parent, name);
      return { kind: info.isSymbolicLink() ? 'link' : 'other' };
    } catch (again) {
      // SAFETY: the operations above throw Error values with an optional errno code.
      if ((again as NodeJS.ErrnoException).code === 'ENOENT')
        return { kind: 'missing' };
      throw again;
    }
  }
  try {
    if (!(await next.stat()).isDirectory()) {
      await next.close();
      return { kind: 'other' };
    }
    if (
      process.platform === 'win32' &&
      windowsReadReparse(next.fd) !== undefined
    ) {
      await next.close();
      return { kind: 'link' };
    }
  } catch (error) {
    await next.close().catch(() => undefined);
    throw error;
  }
  return { kind: 'directory', handle: next };
}
