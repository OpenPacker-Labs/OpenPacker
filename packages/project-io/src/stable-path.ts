/**
 * Open an existing path one retained, no-follow ancestor at a time.
 *
 * Joining a name onto `/proc/self/fd/N` is how Linux reaches "a child of this
 * open directory", and it does not work on macOS, where `/dev/fd/N/child`
 * names nothing (ADR 0045). Every step here goes through `openChild`, so each
 * platform uses the call that is a child open: a swapped ancestor cannot
 * redirect a step, and a symlink in any component below the path's base is
 * refused rather than followed.
 */

import { type FileHandle } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { supportsStableHandles } from './handle-path.js';
import { StableHandleError } from './handle-support.js';
import { walkStable } from './stable-walk.js';

export interface StablePathOptions {
  /** Let the last component be a regular file as well as a directory. */
  allowFile?: boolean;
}

/**
 * The open handle of `path`, which must exist and be absolute. Nothing is
 * created. A missing component, or a symlink anywhere below the base `path`
 * lies under, is an error from the open (`ENOENT`, `ELOOP`, `ENOTDIR`); a last component that is neither a
 * directory nor, with `allowFile`, a regular file is a `StableHandleError`.
 * The caller closes the handle.
 */
export async function openStablePath(
  path: string,
  options: StablePathOptions = {},
): Promise<FileHandle> {
  if (!supportsStableHandles())
    throw new StableHandleError(
      'Stable paths need handle-relative I/O, which this platform does not have',
    );
  if (!isAbsolute(path))
    throw new StableHandleError(`Refusing a relative stable path: ${path}`);
  const allowFile = options.allowFile === true;
  // The base `path` lies under is opened as its real path, as every stable
  // walk opens it (trusted-base.ts); a link anywhere below it is refused. The
  // sandbox hands this real paths already (`assertSafeJailPath`), so for its
  // grants nothing changes.
  return walkStable(path, {
    lastMayBeFile: allowFile,
    kindError: (part) =>
      new StableHandleError(
        allowFile
          ? `Not a regular file or directory: ${part}`
          : `Not a directory: ${part}`,
      ),
  });
}
