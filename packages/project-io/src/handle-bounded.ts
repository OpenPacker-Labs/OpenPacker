/**
 * A bounded listing of an open directory, through the same handle on every
 * platform.
 *
 * `readDirChildWithTypes` reads a directory whole, so a directory a hostile
 * process filled with millions of names costs that much memory before any
 * bound can be applied. `readDirChildBounded` stops at the first entry past
 * the bound: `exceeded` is then true and `entries` holds the ones read, in no
 * particular order. A directory within the bound comes back whole, typed the
 * way `readDirChildWithTypes` types it (an entry the filesystem gave no type
 * for is looked at, not guessed).
 *
 * Kept beside `handle-path.ts` and reaching its backends through the exports
 * the link code uses, so the platform file does not grow for it:
 *
 * - Linux: `opendir` on `/proc/self/fd/N`, stopped at the bound.
 * - macOS: libc `readdir` on a descriptor of its own, stopped at the bound
 *   (`handle-libc-list.ts`).
 * - Windows: `NtQueryDirectoryFile`, stopped at the bound (`handle-nt-dir.ts`).
 */

import { type Dirent } from 'node:fs';
import { lstat, opendir, type FileHandle } from 'node:fs/promises';
import { direntOf } from './handle-libc-list.js';
import { entryKindOfMode } from './handle-libc-profile.js';
import { scanNtDirectory } from './handle-nt-dir.js';
import {
  libcBackend,
  nt,
  posixChild,
  stableHandlePath,
  throwNt,
} from './handle-path.js';
import { type BoundedListing } from './handle-support.js';

/**
 * The entries of an open directory, read only until it is clear that there are
 * more than `limit` of them.
 */
export async function readDirChildBounded(
  parent: FileHandle,
  limit: number,
): Promise<BoundedListing> {
  if (!Number.isSafeInteger(limit) || limit < 0)
    throw new RangeError(`Listing bound must be a count, not ${limit}`);
  if (process.platform === 'win32')
    return scanNtDirectory(nt(), parent.fd, throwNt, limit);
  const libc = libcBackend();
  if (libc !== undefined) return libc.readDirChildBounded(parent, limit);
  const directory = await opendir(stableHandlePath(parent));
  const entries: Dirent[] = [];
  try {
    for (;;) {
      const entry = await directory.read();
      if (entry === null) return { entries, exceeded: false };
      if (entries.length >= limit) return { entries, exceeded: true };
      entries.push(await typedEntry(parent, entry));
    }
  } finally {
    await directory.close().catch(() => undefined);
  }
}

/** `entry`, or what lstat says it is when the filesystem reported no type. */
async function typedEntry(parent: FileHandle, entry: Dirent): Promise<Dirent> {
  if (
    entry.isFile() ||
    entry.isDirectory() ||
    entry.isSymbolicLink() ||
    entry.isBlockDevice() ||
    entry.isCharacterDevice() ||
    entry.isFIFO() ||
    entry.isSocket()
  )
    return entry;
  const info = await lstat(posixChild(parent, entry.name), { bigint: true });
  return direntOf(entry.name, entryKindOfMode(info.mode));
}
