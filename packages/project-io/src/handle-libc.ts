/**
 * Handle-relative child I/O through the C library's `*at()` calls.
 *
 * Linux resolves `/proc/self/fd/N/child` through a magic link, so ordinary fs
 * calls on that path are fd-relative. macOS has no such link: `/dev/fd/N` is a
 * file-descriptor filesystem whose entries are the descriptors themselves, and
 * `/dev/fd/N/child` does not resolve. Here every child operation is one
 * `openat`, `mkdirat`, `renameat`, `unlinkat` or `fstatat` against the parent's
 * descriptor, the same way the Windows backend does it with NtCreateFile and a
 * RootDirectory. No operation builds a path to walk, so a swapped ancestor
 * cannot redirect it, and a symlink in the final component is refused by
 * O_NOFOLLOW or AT_SYMLINK_NOFOLLOW.
 *
 * The functions are bound through koffi from whatever `LibcAtProfile` is
 * injected. The macOS profile ships; the glibc profile lets the same code run
 * against a real libc on Linux, where the suite compares it with the
 * /proc/self/fd backend.
 */

import { constants, type BigIntStats, type Dirent } from 'node:fs';
import { type FileHandle } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { constants as osConstants } from 'node:os';
import {
  attempt,
  bindLibc,
  check,
  openFd,
  type Koffi,
  type LibcApi,
} from './handle-libc-api.js';
import { direntOf, listEntries, type Entry } from './handle-libc-list.js';
import {
  makeLink,
  readLinkText,
  removeEmptyDirectory,
  removeNonDirectory,
} from './handle-libc-link.js';
import {
  bigIntStatsFrom,
  entryKindOfMode,
  type LibcAtProfile,
} from './handle-libc-profile.js';
import {
  lstatRaw as decodedLstat,
  verifyDirentLayout,
  type Verified,
} from './handle-libc-verify.js';
import {
  StableHandleError,
  locateModuleFile,
  wrapFd,
} from './handle-support.js';

/** One implementation of the child operations `handle-path.ts` exposes. */
export interface ChildBackend {
  readonly id: string;
  openChild(
    parent: FileHandle,
    name: string,
    flags: number,
    mode?: number,
  ): Promise<FileHandle>;
  mkdirChild(parent: FileHandle, name: string): Promise<void>;
  renameChild(parent: FileHandle, from: string, to: string): Promise<void>;
  removeChild(
    parent: FileHandle,
    name: string,
    options: { recursive?: boolean; force?: boolean },
  ): Promise<void>;
  lstatChild(parent: FileHandle, name: string): Promise<BigIntStats>;
  readDirChild(parent: FileHandle): Promise<string[]>;
  readDirChildWithTypes(parent: FileHandle): Promise<Dirent[]>;
  /** `symlinkat(target, parent, name)`: the link is the new child; `target` is its text, not followed. */
  symlinkChild(parent: FileHandle, name: string, target: string): Promise<void>;
  /** `readlinkat(parent, name)`: the text of a link child; EINVAL when the child is not a link. */
  readlinkChild(parent: FileHandle, name: string): Promise<string>;
  /** `unlinkat(parent, name, 0)`: a file or a link goes, a directory is refused by the system. */
  unlinkNonDirectory(parent: FileHandle, name: string): Promise<void>;
  /** `unlinkat(parent, name, AT_REMOVEDIR)`: an empty directory goes; ENOTEMPTY otherwise. */
  rmdirChild(parent: FileHandle, name: string): Promise<void>;
}

/** Where this module was loaded from, in a form `createRequire` accepts. */
export function libcModuleFromStack(stack: string): string | undefined {
  return locateModuleFile(stack, 'handle-libc');
}

function loadKoffi(): Koffi {
  const file = libcModuleFromStack(new Error().stack ?? '');
  if (file === undefined)
    throw new StableHandleError(
      'Handle-relative I/O could not locate this module to load koffi',
    );
  try {
    // SAFETY: koffi is this package's own dependency; the interface above names the part used.
    return createRequire(file)('koffi') as Koffi;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new StableHandleError(
      `Handle-relative I/O could not load koffi: ${reason}`,
    );
  }
}

function isAbsent(error: NodeJS.ErrnoException): boolean {
  return error.code === 'ENOENT';
}

/** What Node's `rm` throws for a directory it was not told to recurse into. */
function directoryRefused(name: string): Error {
  const error: NodeJS.ErrnoException = new Error(
    `Path is a directory: rm returned EISDIR (is a directory) ${name}`,
  );
  error.name = 'SystemError';
  error.code = 'ERR_FS_EISDIR';
  error.errno = osConstants.errno.EISDIR;
  error.syscall = 'rm';
  error.path = name;
  return error;
}

/**
 * The libc `*at()` implementation of the child operations for one profile.
 * Binding is lazy: nothing is loaded until the first call, and a profile that
 * cannot be bound throws StableHandleError there, never falling back to a path.
 */
export function createLibcAtBackend(profile: LibcAtProfile): ChildBackend {
  let bound: LibcApi | undefined;
  const verified: Verified = { stat: false, dirent: false, link: false };
  const native = (): LibcApi => (bound ??= bindLibc(profile, loadKoffi()));

  function lstatRaw(api: LibcApi, dirfd: number, name: string) {
    return decodedLstat(api, verified, dirfd, name);
  }

  function list(api: LibcApi, dirfd: number, display: string): Entry[] {
    verifyDirentLayout(api, verified);
    return listEntries(api, dirfd, display);
  }

  function unlink(
    api: LibcApi,
    dirfd: number,
    name: string,
    flags: number,
  ): void {
    check(
      attempt(api, () => api.unlinkat(dirfd, name, flags)),
      'unlink',
      name,
    );
  }

  function removeDirectory(api: LibcApi, dirfd: number, name: string): void {
    const fd = openFd(
      api,
      dirfd,
      name,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      0,
      'rm',
      name,
    );
    try {
      for (const entry of list(api, fd, name)) {
        try {
          removeEntry(api, fd, entry);
        } catch (error) {
          // An entry that vanished meanwhile is already gone, which is the goal.
          // SAFETY: failures here are Error values built in this module or by koffi.
          if (!isAbsent(error as NodeJS.ErrnoException)) throw error;
        }
      }
    } finally {
      api.close(fd);
    }
    unlink(api, dirfd, name, profile.atRemoveDir);
  }

  function removeEntry(api: LibcApi, dirfd: number, entry: Entry): void {
    const kind =
      entry.kind === 'unknown'
        ? entryKindOfMode(lstatRaw(api, dirfd, entry.name).mode)
        : entry.kind;
    if (kind === 'directory') removeDirectory(api, dirfd, entry.name);
    else unlink(api, dirfd, entry.name, 0);
  }

  async function entriesOf(
    parent: FileHandle,
    typed: boolean,
  ): Promise<Entry[]> {
    const api = native();
    const listed = list(api, parent.fd, `fd ${parent.fd}`);
    if (!typed) return listed;
    const resolved: Entry[] = [];
    for (const entry of listed) {
      if (entry.kind !== 'unknown') {
        resolved.push(entry);
        continue;
      }
      // The filesystem gave no d_type: ask it, as Node's readdir does.
      try {
        resolved.push({
          name: entry.name,
          kind: entryKindOfMode(lstatRaw(api, parent.fd, entry.name).mode),
        });
      } catch (error) {
        // SAFETY: failures here are Error values built in this module or by koffi.
        if (!isAbsent(error as NodeJS.ErrnoException)) throw error;
      }
    }
    return resolved;
  }

  return {
    id: profile.id,

    async openChild(parent, name, flags, mode) {
      const api = native();
      return wrapFd(
        openFd(api, parent.fd, name, flags, mode ?? 0o666, 'open', name),
        true,
      );
    },

    async mkdirChild(parent, name) {
      const api = native();
      check(
        attempt(api, () => api.mkdirat(parent.fd, name, 0o777)),
        'mkdir',
        name,
      );
    },

    async renameChild(parent, from, to) {
      const api = native();
      check(
        attempt(api, () => api.renameat(parent.fd, from, parent.fd, to)),
        'rename',
        from,
        to,
      );
    },

    async removeChild(parent, name, options) {
      const api = native();
      try {
        const kind = entryKindOfMode(lstatRaw(api, parent.fd, name).mode);
        if (kind !== 'directory') unlink(api, parent.fd, name, 0);
        else if (options.recursive === true)
          removeDirectory(api, parent.fd, name);
        else throw directoryRefused(name);
      } catch (error) {
        // SAFETY: failures here are Error values built in this module or by koffi.
        if (options.force === true && isAbsent(error as NodeJS.ErrnoException))
          return;
        throw error;
      }
    },

    async symlinkChild(parent, name, target) {
      makeLink(native(), verified, parent.fd, name, target);
    },

    async readlinkChild(parent, name) {
      return readLinkText(native(), parent.fd, name);
    },

    async unlinkNonDirectory(parent, name) {
      removeNonDirectory(native(), parent.fd, name);
    },

    async rmdirChild(parent, name) {
      removeEmptyDirectory(native(), parent.fd, name);
    },

    async lstatChild(parent, name) {
      return bigIntStatsFrom(lstatRaw(native(), parent.fd, name));
    },

    async readDirChild(parent) {
      return (await entriesOf(parent, false)).map((entry) => entry.name);
    },

    async readDirChildWithTypes(parent) {
      return (await entriesOf(parent, true)).map((entry) =>
        direntOf(entry.name, entry.kind),
      );
    },
  };
}
