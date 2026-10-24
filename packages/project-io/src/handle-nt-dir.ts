/**
 * Listing a directory through an open NT handle (NtQueryDirectoryFile).
 *
 * Kept apart from `handle-path.ts` and given the NT API to call, as
 * `handle-nt-reparse.ts` is, so the listing and the rest of the Windows
 * backend share no import. Each entry is typed from its file attributes, and an
 * entry that is a reparse point is typed as a link and as neither a file nor a
 * directory: a listing never says "directory" of a junction.
 */

import type { Dirent } from 'node:fs';
import type { BoundedListing } from './handle-support.js';

const STATUS_SUCCESS = 0;
const STATUS_NO_MORE_FILES = 0x80000006;
const FILE_ATTRIBUTE_DIRECTORY = 0x00000010;
const FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;
const FileDirectoryInformation = 1;

/** The two NT entry points the listing needs, as `handle-path.ts` binds them. */
export interface NtQueryDirectory {
  getOsFHandle(fd: number): object;
  NtQueryDirectoryFile(...args: never[]): number;
}

/**
 * Every entry of the directory behind `fd`, typed. `fail` turns an NT status
 * that is not success into the error the caller's backend throws.
 */
export function listNtDirectory(
  api: NtQueryDirectory,
  fd: number,
  fail: (status: number, name: string) => never,
): Dirent[] {
  return scanNtDirectory(api, fd, fail, Number.POSITIVE_INFINITY).entries;
}

/**
 * `listNtDirectory` that stops querying at the first entry past `limit`, so a
 * directory of millions of names is never held in memory. When it stops early
 * `exceeded` is true and the entries are the ones read so far.
 */
export function scanNtDirectory(
  api: NtQueryDirectory,
  fd: number,
  fail: (status: number, name: string) => never,
  limit: number,
): BoundedListing {
  const osHandle = api.getOsFHandle(fd);
  const buffer = Buffer.alloc(16 * 1024);
  const iosb = Buffer.alloc(16);
  const entries: Dirent[] = [];
  let restart = 1;
  for (;;) {
    const status =
      api.NtQueryDirectoryFile(
        // SAFETY: The surrounding boundary establishes the asserted domain contract.
        ...([
          osHandle,
          null,
          null,
          null,
          iosb,
          buffer,
          buffer.length,
          FileDirectoryInformation,
          0,
          null,
          restart,
        ] as never[]),
      ) >>> 0;
    restart = 0;
    if (status === STATUS_NO_MORE_FILES) break;
    if (status !== STATUS_SUCCESS) fail(status, '<directory>');
    let offset = 0;
    for (;;) {
      const next = buffer.readUInt32LE(offset);
      const attributes = buffer.readUInt32LE(offset + 56);
      const nameLength = buffer.readUInt32LE(offset + 60);
      const name = buffer.toString(
        'utf16le',
        offset + 64,
        offset + 64 + nameLength,
      );
      if (name !== '.' && name !== '..') {
        if (entries.length >= limit) return { entries, exceeded: true };
        entries.push(ntDirent(name, attributes));
      }
      if (next === 0) break;
      offset += next;
    }
  }
  return { entries, exceeded: false };
}

function ntDirent(name: string, attributes: number): Dirent {
  const reparse = (attributes & FILE_ATTRIBUTE_REPARSE_POINT) !== 0;
  const directory = (attributes & FILE_ATTRIBUTE_DIRECTORY) !== 0;
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  return {
    name,
    isDirectory: () => directory && !reparse,
    isFile: () => !directory && !reparse,
    isSymbolicLink: () => reparse,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
  } as Dirent;
}
