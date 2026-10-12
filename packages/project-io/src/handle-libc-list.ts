/**
 * Listing a directory through `fdopendir`/`readdir`, with the entry types the
 * filesystem gave (`d_type`), in the byte order Node's `readdir` returns.
 */

import { constants, type Dirent } from 'node:fs';
import { openFd, systemError, type LibcApi } from './handle-libc-api.js';
import { entryKindOfType, type EntryKind } from './handle-libc-profile.js';

export interface Entry {
  readonly name: string;
  readonly kind: EntryKind;
}

/**
 * Entries of an open directory, without . and .., in byte order (what Node's
 * readdir returns). The listing runs on a descriptor of its own, opened as "."
 * against the caller's, so it starts at offset 0 and shares no position with
 * the caller; closedir() closes it.
 */
export function listEntries(
  api: LibcApi,
  dirfd: number,
  display: string,
): Entry[] {
  const { koffi, profile } = api;
  const fd = openFd(
    api,
    dirfd,
    '.',
    constants.O_RDONLY | constants.O_DIRECTORY,
    0,
    'scandir',
    display,
  );
  const stream = api.fdopendir(fd);
  if (stream === null) {
    const errno = koffi.errno();
    api.close(fd);
    throw systemError(errno, 'scandir', display);
  }
  const found: Entry[] = [];
  try {
    for (;;) {
      koffi.errno(0);
      const record = api.readdir(stream);
      if (record === null) {
        const errno = koffi.errno();
        if (errno !== 0) throw systemError(errno, 'scandir', display);
        break;
      }
      const name = String(
        koffi.decode(record, profile.dirent.nameOffset, 'char', -1),
      );
      if (name === '.' || name === '..') continue;
      const type = Number(
        koffi.decode(record, profile.dirent.typeOffset, 'uint8'),
      );
      found.push({ name, kind: entryKindOfType(type) });
    }
  } finally {
    api.closedir(stream);
  }
  // Node's readdir returns names in byte order; sort on the UTF-8 bytes once.
  return found
    .map((entry) => ({ entry, key: Buffer.from(entry.name) }))
    .sort((a, b) => Buffer.compare(a.key, b.key))
    .map(({ entry }) => entry);
}

export function nodeKind(entry: Dirent): EntryKind {
  if (entry.isDirectory()) return 'directory';
  if (entry.isFile()) return 'file';
  if (entry.isSymbolicLink()) return 'symlink';
  if (entry.isFIFO()) return 'fifo';
  if (entry.isSocket()) return 'socket';
  if (entry.isCharacterDevice()) return 'character';
  if (entry.isBlockDevice()) return 'block';
  return 'unknown';
}

export function direntOf(name: string, kind: EntryKind): Dirent {
  return {
    name,
    parentPath: '',
    isFile: () => kind === 'file',
    isDirectory: () => kind === 'directory',
    isSymbolicLink: () => kind === 'symlink',
    isBlockDevice: () => kind === 'block',
    isCharacterDevice: () => kind === 'character',
    isFIFO: () => kind === 'fifo',
    isSocket: () => kind === 'socket',
  };
}
