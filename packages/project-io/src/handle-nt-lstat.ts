/**
 * What a name is on Windows, looked at and not followed.
 *
 * The name is opened as itself (`FILE_OPEN_REPARSE_POINT`) and the open handle
 * is statted. But statting an open NT handle is libuv's `fstat`, which never
 * reports a symbolic link: a junction answers "directory" and a file symlink
 * answers "regular file". So "is this a link" is not read from the stat. It is
 * asked of the reparse point itself (`FSCTL_GET_REPARSE_POINT`) on the same
 * handle, and the stat that comes back says what the reparse data says:
 *
 * - a mount point (junction) or a symbolic link is a **link**, and neither a
 *   directory nor a file;
 * - any other reparse tag (a OneDrive placeholder, a deduplicated file) is a
 *   thing this package neither makes nor follows, and is neither link, file nor
 *   directory, as `handle-nt-dir.ts` types it in a listing;
 * - no reparse data is the stat as it was.
 *
 * `lstatChild` is the one place this is decided; the member-link reader, the
 * tree walkers and the snapshot comparison all ask `lstatChild`. The seam is a
 * function of an already-open handle and a reader of reparse data, so the
 * decision can be run on any platform against stand-ins for both.
 */

import type { BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import {
  IO_REPARSE_TAG_MOUNT_POINT,
  IO_REPARSE_TAG_SYMLINK,
} from './reparse-data.js';

/** The reparse data of an open handle (`FSCTL_GET_REPARSE_POINT`), or undefined when it has none. */
export type ReparseReader = (fd: number) => Buffer | undefined;

/**
 * Stat a handle opened on the name itself, read its reparse data, and close it.
 * A reader that fails fails the call: a handle that cannot say whether it is a
 * link is not taken for one that is not.
 */
export async function lstatOpened(
  handle: FileHandle,
  readReparse: ReparseReader,
): Promise<BigIntStats> {
  try {
    const stats = await handle.stat({ bigint: true });
    const reparse = readReparse(handle.fd);
    return reparse === undefined ? stats : asReparsePoint(stats, reparse);
  } finally {
    await handle.close();
  }
}

/** `stats`, answering for a reparse point: a link or not by its tag, never a directory or a file. */
function asReparsePoint(stats: BigIntStats, reparse: Buffer): BigIntStats {
  const tag = reparse.readUInt32LE(0);
  const link =
    tag === IO_REPARSE_TAG_MOUNT_POINT || tag === IO_REPARSE_TAG_SYMLINK;
  // SAFETY: the object answers every other BigIntStats member through its prototype, the stat itself.
  return Object.create(stats, {
    isSymbolicLink: { value: () => link },
    isDirectory: { value: () => false },
    isFile: { value: () => false },
  }) as BigIntStats;
}
