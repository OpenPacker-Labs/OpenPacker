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

import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readdirSync,
  type BigIntStats,
  type Dirent,
} from 'node:fs';
import { type FileHandle } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { constants as osConstants } from 'node:os';
import { getSystemErrorMap } from 'node:util';
import {
  bigIntStatsFrom,
  decodeStat,
  entryKindOfMode,
  entryKindOfType,
  type DecodedStat,
  type EntryKind,
  type LibcAtProfile,
  type LibcSymbol,
} from './handle-libc-profile.js';
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
}

interface NativePointer {
  readonly nativePointer: true;
}

type KoffiCallable = (...args: never[]) => number | NativePointer | null;

interface KoffiLibrary {
  func(
    name: string,
    result: string,
    parameters: readonly string[],
  ): KoffiCallable;
}

interface Koffi {
  load(name: string): KoffiLibrary;
  errno(value?: number): number;
  decode(
    pointer: NativePointer,
    offset: number,
    type: string,
    length?: number,
  ): number | string;
}

interface LibcApi {
  readonly profile: LibcAtProfile;
  readonly koffi: Koffi;
  openat(dirfd: number, path: string, flags: number, mode: number): number;
  mkdirat(dirfd: number, path: string, mode: number): number;
  renameat(fromfd: number, from: string, tofd: number, to: string): number;
  unlinkat(dirfd: number, path: string, flags: number): number;
  fstatat(dirfd: number, path: string, out: Buffer, flags: number): number;
  symlinkat(target: string, newdirfd: number, linkpath: string): number;
  readlinkat(dirfd: number, path: string, out: Buffer, size: number): number;
  fdopendir(fd: number): NativePointer | null;
  readdir(stream: NativePointer): NativePointer | null;
  closedir(stream: NativePointer): number;
  close(fd: number): number;
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

/** The signatures koffi is asked to bind; `openat` is variadic. */
type OpenatCall = (
  dirfd: number,
  path: string,
  flags: number,
  modeType: 'int',
  mode: number,
) => number;
type MkdiratCall = (dirfd: number, path: string, mode: number) => number;
type RenameatCall = (
  fromfd: number,
  from: string,
  tofd: number,
  to: string,
) => number;
type UnlinkatCall = (dirfd: number, path: string, flags: number) => number;
type FstatatCall = (
  dirfd: number,
  path: string,
  out: Buffer,
  flags: number,
) => number;
type SymlinkatCall = (
  target: string,
  newdirfd: number,
  linkpath: string,
) => number;
type ReadlinkatCall = (
  dirfd: number,
  path: string,
  out: Buffer,
  size: number,
) => number;
type FdopendirCall = (fd: number) => NativePointer | null;
type ReaddirCall = (stream: NativePointer) => NativePointer | null;
type ClosedirCall = (stream: NativePointer) => number;
type CloseCall = (fd: number) => number;

function bindLibc(profile: LibcAtProfile): LibcApi {
  const koffi = loadKoffi();
  let library: KoffiLibrary | undefined;
  const failures: string[] = [];
  for (const name of profile.libraries) {
    try {
      library = koffi.load(name);
      break;
    } catch (error) {
      failures.push(
        `${name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (library === undefined)
    throw new StableHandleError(
      `Handle-relative I/O could not load ${profile.libraries.join(' or ')}: ${failures.join('; ')}`,
    );
  const loaded = library;
  function bind<Call>(
    symbol: LibcSymbol,
    result: string,
    parameters: readonly string[],
  ): Call {
    const names = profile.symbols[symbol];
    const reasons: string[] = [];
    for (const name of names) {
      try {
        // SAFETY: the declaration handed to koffi is the signature Call names.
        return loaded.func(name, result, parameters) as Call;
      } catch (error) {
        reasons.push(error instanceof Error ? error.message : String(error));
      }
    }
    throw new StableHandleError(
      `${profile.libraries.join(' or ')} exports none of ${names.join(', ')}: ${reasons.join('; ')}`,
    );
  }
  const openat = bind<OpenatCall>('openat', 'int', [
    'int',
    'str',
    'int',
    '...',
  ]);
  const mkdirat = bind<MkdiratCall>('mkdirat', 'int', ['int', 'str', 'uint32']);
  const renameat = bind<RenameatCall>('renameat', 'int', [
    'int',
    'str',
    'int',
    'str',
  ]);
  const unlinkat = bind<UnlinkatCall>('unlinkat', 'int', ['int', 'str', 'int']);
  const fstatat = bind<FstatatCall>('fstatat', 'int', [
    'int',
    'str',
    'void *',
    'int',
  ]);
  // symlinkat(target, newdirfd, linkpath) puts the directory between the two
  // paths; readlinkat returns an ssize_t, which koffi gives back as a number.
  const symlinkat = bind<SymlinkatCall>('symlinkat', 'int', [
    'str',
    'int',
    'str',
  ]);
  const readlinkat = bind<ReadlinkatCall>('readlinkat', 'int64', [
    'int',
    'str',
    'void *',
    'uint64',
  ]);
  const fdopendir = bind<FdopendirCall>('fdopendir', 'void *', ['int']);
  const readdir = bind<ReaddirCall>('readdir', 'void *', ['void *']);
  const closedir = bind<ClosedirCall>('closedir', 'int', ['void *']);
  const close = bind<CloseCall>('close', 'int', ['int']);
  return {
    profile,
    koffi,
    // openat() is variadic: koffi wants the type of each extra argument ahead
    // of its value, and on arm64 macOS passes it on the stack.
    openat: (dirfd, path, flags, mode) =>
      openat(dirfd, path, flags, 'int', mode),
    mkdirat,
    renameat,
    unlinkat,
    fstatat,
    symlinkat,
    readlinkat,
    fdopendir,
    readdir,
    closedir,
    close,
  };
}

interface Outcome {
  readonly result: number;
  readonly errno: number;
}

const MAX_INTERRUPTED_RETRIES = 64;

/** Run a call, retrying EINTR the way libuv does, and read errno at once. */
function attempt(api: LibcApi, run: () => number): Outcome {
  for (let tries = 0; ; tries += 1) {
    const result = run();
    if (result >= 0) return { result, errno: 0 };
    const errno = api.koffi.errno();
    if (errno !== osConstants.errno.EINTR || tries >= MAX_INTERRUPTED_RETRIES)
      return { result, errno };
  }
}

function errnoCode(errno: number): string {
  const known = getSystemErrorMap().get(-errno)?.[0];
  if (known !== undefined) return known;
  for (const [name, value] of Object.entries(osConstants.errno))
    if (value === errno) return name;
  return 'UNKNOWN';
}

/** A Node-shaped system error: `ENOENT: no such file or directory, mkdir 'x'`. */
function systemError(
  errno: number,
  syscall: string,
  path: string,
  dest?: string,
): NodeJS.ErrnoException {
  if (errno <= 0)
    return new StableHandleError(
      `${syscall} '${path}' failed without reporting an errno`,
    );
  const code = errnoCode(errno);
  const text = getSystemErrorMap().get(-errno)?.[1] ?? 'unknown error';
  const suffix = dest === undefined ? '' : ` -> '${dest}'`;
  const error: NodeJS.ErrnoException & { dest?: string } = new Error(
    `${code}: ${text}, ${syscall} '${path}'${suffix}`,
  );
  error.code = code;
  error.errno = -errno;
  error.syscall = syscall;
  error.path = path;
  if (dest !== undefined) error.dest = dest;
  return error;
}

function check(
  outcome: Outcome,
  syscall: string,
  path: string,
  dest?: string,
): number {
  if (outcome.result < 0) throw systemError(outcome.errno, syscall, path, dest);
  return outcome.result;
}

function openFd(
  api: LibcApi,
  dirfd: number,
  path: string,
  flags: number,
  mode: number,
  syscall: string,
  display: string,
): number {
  return check(
    attempt(api, () =>
      api.openat(dirfd, path, flags | api.profile.openCloexec, mode),
    ),
    syscall,
    display,
  );
}

/** A directory whose stat and listing are compared with Node's before they are trusted. */
const REFERENCE_DIRECTORY = '/';

interface Verified {
  stat: boolean;
  dirent: boolean;
  /** symlinkat, readlinkat and fstatat agreed about the first link made. */
  link: boolean;
}

/** Bytes a link target may take; Linux and macOS PATH_MAX are 4096 and 1024. */
const LINK_BUFFER_BYTES = 4096;

function statMismatches(libc: DecodedStat, node: BigIntStats): string[] {
  const rows: [string, bigint, bigint][] = [
    ['dev', libc.dev, node.dev],
    ['ino', libc.ino, node.ino],
    ['mode', libc.mode, node.mode],
    ['nlink', libc.nlink, node.nlink],
    ['uid', libc.uid, node.uid],
    ['gid', libc.gid, node.gid],
    ['size', libc.size, node.size],
    ['mtimeNs', libc.mtimeNs, node.mtimeNs],
    ['ctimeNs', libc.ctimeNs, node.ctimeNs],
  ];
  return rows
    .filter(([, mine, theirs]) => mine !== theirs)
    .map(([field, mine, theirs]) => `${field} libc=${mine} node=${theirs}`);
}

/**
 * Refuse to trust a `struct stat` layout Node does not agree with.
 *
 * The layout tables are written from headers, and the macOS one had never run
 * on a Mac when this was written. A wrong table would otherwise surface as a
 * puzzling INPUT_CHANGED far from here, so the first stat compares the
 * reference directory's decoded fields with `fs.fstat` of the same descriptor
 * and, on a difference, names the field and dumps the raw bytes.
 */
function verifyStatLayout(api: LibcApi, verified: Verified): void {
  if (verified.stat) return;
  const { profile } = api;
  const reference = openSync(
    REFERENCE_DIRECTORY,
    constants.O_RDONLY | constants.O_DIRECTORY,
  );
  try {
    let last = '';
    // A rare concurrent change to the reference between the two reads is retried.
    for (let round = 0; round < 3; round += 1) {
      const buffer = Buffer.alloc(profile.stat.bufferSize);
      check(
        attempt(api, () =>
          api.fstatat(reference, '.', buffer, profile.atSymlinkNoFollow),
        ),
        'fstatat',
        REFERENCE_DIRECTORY,
      );
      const mismatches = statMismatches(
        decodeStat(buffer, profile.stat),
        fstatSync(reference, { bigint: true }),
      );
      if (mismatches.length === 0) {
        verified.stat = true;
        return;
      }
      last = `${mismatches.join('; ')}; bytes ${buffer.subarray(0, 160).toString('hex')}`;
    }
    throw new StableHandleError(
      `libc struct stat layout "${profile.id}" disagrees with Node: ${last}`,
    );
  } finally {
    closeSync(reference);
  }
}

interface Entry {
  readonly name: string;
  readonly kind: EntryKind;
}

/**
 * Entries of an open directory, without . and .., in byte order (what Node's
 * readdir returns). The listing runs on a descriptor of its own, opened as "."
 * against the caller's, so it starts at offset 0 and shares no position with
 * the caller; closedir() closes it.
 */
function listEntries(api: LibcApi, dirfd: number, display: string): Entry[] {
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

function nodeKind(entry: Dirent): EntryKind {
  if (entry.isDirectory()) return 'directory';
  if (entry.isFile()) return 'file';
  if (entry.isSymbolicLink()) return 'symlink';
  if (entry.isFIFO()) return 'fifo';
  if (entry.isSocket()) return 'socket';
  if (entry.isCharacterDevice()) return 'character';
  if (entry.isBlockDevice()) return 'block';
  return 'unknown';
}

/** The `struct dirent` counterpart of verifyStatLayout. */
function verifyDirentLayout(api: LibcApi, verified: Verified): void {
  if (verified.dirent) return;
  const reference = openSync(
    REFERENCE_DIRECTORY,
    constants.O_RDONLY | constants.O_DIRECTORY,
  );
  try {
    const mine = listEntries(api, reference, REFERENCE_DIRECTORY);
    const node = new Map(
      readdirSync(REFERENCE_DIRECTORY, { withFileTypes: true }).map((entry) => [
        entry.name,
        nodeKind(entry),
      ]),
    );
    const agrees =
      mine.length === node.size &&
      mine.every((entry) => {
        const other = node.get(entry.name);
        return (
          other !== undefined &&
          (other === entry.kind ||
            other === 'unknown' ||
            entry.kind === 'unknown')
        );
      });
    if (!agrees)
      throw new StableHandleError(
        `libc struct dirent layout "${api.profile.id}" disagrees with Node: libc ${JSON.stringify(
          mine.slice(0, 8),
        )} node ${JSON.stringify([...node].slice(0, 8))}`,
      );
    verified.dirent = true;
  } finally {
    closeSync(reference);
  }
}

function direntOf(name: string, kind: EntryKind): Dirent {
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
  const native = (): LibcApi => (bound ??= bindLibc(profile));

  function lstatRaw(api: LibcApi, dirfd: number, name: string): DecodedStat {
    verifyStatLayout(api, verified);
    const buffer = Buffer.alloc(profile.stat.bufferSize);
    check(
      attempt(api, () =>
        api.fstatat(dirfd, name, buffer, profile.atSymlinkNoFollow),
      ),
      'lstat',
      name,
    );
    return decodeStat(buffer, profile.stat);
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

  function readLinkText(api: LibcApi, dirfd: number, name: string): string {
    const buffer = Buffer.alloc(LINK_BUFFER_BYTES);
    const length = check(
      attempt(api, () =>
        api.readlinkat(dirfd, name, buffer, LINK_BUFFER_BYTES),
      ),
      'readlink',
      name,
    );
    // readlinkat() does not terminate the text and does not say when it cut
    // it short: a full buffer might be a longer target, so it is not trusted.
    if (length >= LINK_BUFFER_BYTES)
      throw new StableHandleError(
        `readlinkat '${name}' filled its ${LINK_BUFFER_BYTES}-byte buffer; the target may be longer than it can be read`,
      );
    return buffer.toString('utf8', 0, length);
  }

  /**
   * Refuse to trust symlinkat/readlinkat until they have agreed about a link
   * that was just made: the text read back is the text given, and fstatat
   * with AT_SYMLINK_NOFOLLOW sees a link of that length. A wrong argument
   * order or flag value shows up here, naming the call and the raw bytes,
   * not later as a link that points somewhere else.
   */
  function verifyLinkCalls(
    api: LibcApi,
    dirfd: number,
    name: string,
    target: string,
  ): void {
    if (verified.link) return;
    const wanted = Buffer.from(target);
    const read = Buffer.alloc(LINK_BUFFER_BYTES);
    const length = check(
      attempt(api, () => api.readlinkat(dirfd, name, read, LINK_BUFFER_BYTES)),
      'readlink',
      name,
    );
    const seen = lstatRaw(api, dirfd, name);
    const problems: string[] = [];
    if (!read.subarray(0, length).equals(wanted))
      problems.push(
        `readlinkat returned ${length} bytes ${read.subarray(0, length).toString('hex')} but symlinkat was given ${wanted.length} bytes ${wanted.toString('hex')}`,
      );
    if (entryKindOfMode(seen.mode) !== 'symlink')
      problems.push(
        `fstatat with AT_SYMLINK_NOFOLLOW (${api.profile.atSymlinkNoFollow}) reported mode 0o${seen.mode.toString(8)}, which is not a link`,
      );
    else if (seen.size !== BigInt(wanted.length))
      problems.push(
        `fstatat reported a link of ${seen.size} bytes, expected ${wanted.length}`,
      );
    if (problems.length > 0) {
      unlink(api, dirfd, name, 0);
      throw new StableHandleError(
        `libc symlinkat/readlinkat "${api.profile.id}" disagree: ${problems.join('; ')}`,
      );
    }
    verified.link = true;
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
      if (target.includes('\0'))
        throw new StableHandleError(
          `symlinkat target ${JSON.stringify(target)} contains a NUL`,
        );
      const api = native();
      check(
        attempt(api, () => api.symlinkat(target, parent.fd, name)),
        'symlink',
        target,
        name,
      );
      verifyLinkCalls(api, parent.fd, name, target);
    },

    async readlinkChild(parent, name) {
      return readLinkText(native(), parent.fd, name);
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
