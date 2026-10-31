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

import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { isAbsolute, parse, relative, sep } from 'node:path';
import {
  O_DIRECTORY,
  openChild,
  supportsStableHandles,
} from './handle-path.js';
import { StableHandleError } from './handle-support.js';
import { stableTarget } from './trusted-base.js';

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
  const target = stableTarget(path);
  const root = parse(target).root;
  let handle = await open(
    root,
    constants.O_RDONLY | O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const parts = relative(root, target).split(sep).filter(Boolean);
    for (const [index, part] of parts.entries()) {
      const last = index === parts.length - 1;
      // A file is opened non-blocking so a FIFO named as the last component
      // cannot hold the open; it is then refused by the kind check below.
      const next = await openChild(
        handle,
        part,
        constants.O_RDONLY |
          constants.O_NOFOLLOW |
          (last && allowFile ? constants.O_NONBLOCK : O_DIRECTORY),
      );
      const info = await next.stat();
      if (!info.isDirectory() && !(last && allowFile && info.isFile())) {
        await next.close();
        throw new StableHandleError(
          allowFile
            ? `Not a regular file or directory: ${part}`
            : `Not a directory: ${part}`,
        );
      }
      await handle.close();
      handle = next;
    }
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}
