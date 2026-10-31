/**
 * The C library bound through koffi, and the plumbing every call goes through.
 *
 * `bindLibc` resolves each symbol a profile names and returns a typed `LibcApi`;
 * `attempt` runs a call, retrying EINTR the way libuv does and reading errno at
 * once; `check` and `systemError` turn a failed call into the Node-shaped error
 * the /proc/self/fd backend would have thrown. Nothing here knows what a
 * directory operation means: that is `handle-libc.ts`, over these.
 */

import { constants as osConstants } from 'node:os';
import { getSystemErrorMap } from 'node:util';
import type { LibcAtProfile, LibcSymbol } from './handle-libc-profile.js';
import { StableHandleError } from './handle-support.js';

export interface NativePointer {
  readonly nativePointer: true;
}

export type KoffiCallable = (...args: never[]) => number | NativePointer | null;

export interface KoffiLibrary {
  func(
    name: string,
    result: string,
    parameters: readonly string[],
  ): KoffiCallable;
}

export interface Koffi {
  load(name: string): KoffiLibrary;
  errno(value?: number): number;
  decode(
    pointer: NativePointer,
    offset: number,
    type: string,
    length?: number,
  ): number | string;
}

export interface LibcApi {
  readonly profile: LibcAtProfile;
  readonly koffi: Koffi;
  openat(dirfd: number, path: string, flags: number, mode: number): number;
  mkdirat(dirfd: number, path: string, mode: number): number;
  renameat(fromfd: number, from: string, tofd: number, to: string): number;
  unlinkat(dirfd: number, path: string, flags: number): number;
  fstatat(dirfd: number, path: string, out: Buffer, flags: number): number;
  symlinkat(target: string, newdirfd: number, linkpath: string): number;
  readlinkat(dirfd: number, path: string, out: Buffer, size: number): number;
  /** linkat(fromfd, from, tofd, to, 0): a new name for `from`, which is not followed when it is a link. */
  linkat(fromfd: number, from: string, tofd: number, to: string): number;
  /** fcntl(fd, cmd, buffer): F_GETPATH, the only command made. */
  fcntlPath(fd: number, cmd: number, out: Buffer): number;
  fdopendir(fd: number): NativePointer | null;
  readdir(stream: NativePointer): NativePointer | null;
  closedir(stream: NativePointer): number;
  close(fd: number): number;
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
type LinkatCall = (
  fromfd: number,
  from: string,
  tofd: number,
  to: string,
  flags: number,
) => number;
type FcntlCall = (
  fd: number,
  cmd: number,
  outType: 'void *',
  out: Buffer,
) => number;
type FdopendirCall = (fd: number) => NativePointer | null;
type ReaddirCall = (stream: NativePointer) => NativePointer | null;
type ClosedirCall = (stream: NativePointer) => number;
type CloseCall = (fd: number) => number;

export function bindLibc(profile: LibcAtProfile, koffi: Koffi): LibcApi {
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
  const linkat = bind<LinkatCall>('linkat', 'int', [
    'int',
    'str',
    'int',
    'str',
    'int',
  ]);
  // fcntl() is variadic, as openat() is: the buffer's type goes before it.
  const fcntl = bind<FcntlCall>('fcntl', 'int', ['int', 'int', '...']);
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
    // Flag 0: a source that is a link is linked as itself, never followed.
    linkat: (fromfd, from, tofd, to) => linkat(fromfd, from, tofd, to, 0),
    fcntlPath: (fd, cmd, out) => fcntl(fd, cmd, 'void *', out),
    fdopendir,
    readdir,
    closedir,
    close,
  };
}

export interface Outcome {
  readonly result: number;
  readonly errno: number;
}

const MAX_INTERRUPTED_RETRIES = 64;

/** Run a call, retrying EINTR the way libuv does, and read errno at once. */
export function attempt(api: LibcApi, run: () => number): Outcome {
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
export function systemError(
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

export function check(
  outcome: Outcome,
  syscall: string,
  path: string,
  dest?: string,
): number {
  if (outcome.result < 0) throw systemError(outcome.errno, syscall, path, dest);
  return outcome.result;
}

export function openFd(
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
