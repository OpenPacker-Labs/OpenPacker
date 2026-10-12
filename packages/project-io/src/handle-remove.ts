/**
 * The two removals that cannot take more than a link or an empty directory.
 *
 * `removeChild` in `handle-path.ts` removes whatever the name is, and a caller
 * that looked first and removed after (is it a link? is it empty?) acts on what
 * the name has become since. These do not look: the system refuses the wrong
 * kind of thing at the moment it acts.
 */

import { unlink, rmdir, type FileHandle } from 'node:fs/promises';
import {
  StableHandleError,
  assertHandleSegment,
  libcBackend,
  posixChild,
  windowsRemoveChild,
} from './handle-path.js';

/**
 * Remove a file or a link, never a directory: the system refuses a directory
 * (EISDIR on Linux, EPERM on macOS) whatever the name has become since anyone
 * looked at it. Windows has no such call, and takes a link away through its
 * reparse point instead (`unlinkChild` in `handle-link.ts`).
 */
export async function unlinkNonDirectory(
  parent: FileHandle,
  name: string,
): Promise<void> {
  assertHandleSegment(name);
  if (process.platform === 'win32')
    throw new StableHandleError(
      'Windows removes a link through its reparse point (unlinkChild), not by name',
    );
  const libc = libcBackend();
  if (libc !== undefined) return libc.unlinkNonDirectory(parent, name);
  await unlink(posixChild(parent, name));
}

/**
 * Remove an empty directory, and only that: the system decides at the moment of
 * the call, ENOTEMPTY if anything is in it and ENOTDIR if the name is not a
 * directory (a link is not followed). Nothing is listed first, so nothing can
 * arrive between a look and the removal.
 */
export async function rmdirChild(
  parent: FileHandle,
  name: string,
): Promise<void> {
  assertHandleSegment(name);
  if (process.platform === 'win32') {
    await windowsRemoveChild(parent, name, {});
    return;
  }
  const libc = libcBackend();
  if (libc !== undefined) return libc.rmdirChild(parent, name);
  await rmdir(posixChild(parent, name));
}
