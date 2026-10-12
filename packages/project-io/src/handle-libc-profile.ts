/**
 * Platform facts for the libc `*at()` backend: which library and symbols to
 * bind, a few flag values Node does not export, and the byte layout of
 * `struct stat` and `struct dirent`.
 *
 * Everything here is data, kept apart from the code that calls libc so that a
 * mismatch seen in a CI log on a platform nobody has at hand is fixed by
 * editing one constant. Each table says where its numbers come from. The
 * Linux profiles exist so the same backend runs against glibc in tests; the
 * Darwin profiles are what ships. `handle-libc.ts` checks the active layout
 * against Node's own `fstat`/`readdir` before it trusts it.
 */

import { constants, type BigIntStats } from 'node:fs';
import { endianness } from 'node:os';
import { StableHandleError } from './handle-support.js';

/** One integer inside a C struct. */
export interface IntField {
  readonly offset: number;
  readonly width: 2 | 4 | 8;
  readonly signed: boolean;
}

/** A `struct timespec`: both members are 64-bit on every supported target. */
export interface TimeField {
  readonly seconds: IntField;
  readonly nanoseconds: IntField;
}

/** Where each member lives in `struct stat`. */
export interface StatLayout {
  /** Buffer to hand fstatat(); at least sizeof(struct stat). */
  readonly bufferSize: number;
  readonly dev: IntField;
  readonly ino: IntField;
  readonly mode: IntField;
  readonly nlink: IntField;
  readonly uid: IntField;
  readonly gid: IntField;
  readonly rdev: IntField;
  readonly size: IntField;
  readonly blksize: IntField;
  readonly blocks: IntField;
  readonly atime: TimeField;
  readonly mtime: TimeField;
  readonly ctime: TimeField;
  /** Absent where the kernel struct has none; Node reports ctime then. */
  readonly birthtime: TimeField | undefined;
}

/** Where `readdir()` puts the type and the name inside `struct dirent`. */
export interface DirentLayout {
  /** d_type, one byte. */
  readonly typeOffset: number;
  /** d_name, a NUL-terminated string. */
  readonly nameOffset: number;
}

/** The C functions the backend calls; a profile says which exported names to try for each. */
const SYMBOLS = [
  'openat',
  'mkdirat',
  'renameat',
  'unlinkat',
  'fstatat',
  'symlinkat',
  'readlinkat',
  'fdopendir',
  'readdir',
  'closedir',
  'close',
] as const;

export type LibcSymbol = (typeof SYMBOLS)[number];

export interface LibcAtProfile {
  /** Names the profile in diagnostics. */
  readonly id: string;
  /** Arguments to koffi.load(), in order; the first that loads is used. */
  readonly libraries: readonly string[];
  /** Exported names to try for each function, first one that resolves wins. */
  readonly symbols: Readonly<Record<LibcSymbol, readonly string[]>>;
  /** AT_SYMLINK_NOFOLLOW: <fcntl.h>. Node exports no AT_* values. */
  readonly atSymlinkNoFollow: number;
  /** AT_REMOVEDIR: <fcntl.h>. */
  readonly atRemoveDir: number;
  /** O_CLOEXEC: Node's fs.constants omits it, but libuv sets it on every open. */
  readonly openCloexec: number;
  readonly stat: StatLayout;
  readonly dirent: DirentLayout;
}

const u16 = (offset: number): IntField => ({ offset, width: 2, signed: false });
const i32 = (offset: number): IntField => ({ offset, width: 4, signed: true });
const u32 = (offset: number): IntField => ({ offset, width: 4, signed: false });
const u64 = (offset: number): IntField => ({ offset, width: 8, signed: false });
const i64 = (offset: number): IntField => ({ offset, width: 8, signed: true });
const timespec = (offset: number): TimeField => ({
  seconds: i64(offset),
  nanoseconds: i64(offset + 8),
});

/*
 * macOS, 64-bit inode `struct stat` (<sys/stat.h>, __DARWIN_STRUCT_STAT64),
 * 144 bytes. This is the only layout on arm64 and the `$INODE64` one on x86_64.
 *   dev_t st_dev @0 (int32)   mode_t st_mode @4 (u16)   nlink_t st_nlink @6 (u16)
 *   ino64 st_ino @8   uid @16   gid @20   dev_t st_rdev @24 (int32)   pad @28
 *   atimespec @32  mtimespec @48  ctimespec @64  birthtimespec @80
 *   off_t st_size @96   blkcnt_t st_blocks @104   blksize_t st_blksize @112 (int32)
 * UNVERIFIED ON A MAC. If the macOS CI log reports a stat mismatch, this is
 * the table to correct.
 */
const DARWIN_STAT: StatLayout = {
  bufferSize: 256,
  dev: i32(0),
  mode: u16(4),
  nlink: u16(6),
  ino: u64(8),
  uid: u32(16),
  gid: u32(20),
  rdev: i32(24),
  atime: timespec(32),
  mtime: timespec(48),
  ctime: timespec(64),
  birthtime: timespec(80),
  size: i64(96),
  blocks: i64(104),
  blksize: i32(112),
};

/*
 * macOS 64-bit inode `struct dirent` (<sys/dirent.h>, __DARWIN_STRUCT_DIRENTRY):
 *   u64 d_ino @0   u64 d_seekoff @8   u16 d_reclen @16   u16 d_namlen @18
 *   u8 d_type @20   char d_name[1024] @21
 * UNVERIFIED ON A MAC.
 */
const DARWIN_DIRENT: DirentLayout = { typeOffset: 20, nameOffset: 21 };

/*
 * Linux x86_64 `struct stat` (glibc and musl, = the kernel's), 144 bytes:
 *   st_dev u64 @0   st_ino u64 @8   st_nlink u64 @16   st_mode u32 @24
 *   st_uid u32 @28   st_gid u32 @32   pad @36   st_rdev u64 @40   st_size i64 @48
 *   st_blksize i64 @56   st_blocks i64 @64   atim @72  mtim @88  ctim @104
 */
const LINUX_X64_STAT: StatLayout = {
  bufferSize: 256,
  dev: u64(0),
  ino: u64(8),
  nlink: u64(16),
  mode: u32(24),
  uid: u32(28),
  gid: u32(32),
  rdev: u64(40),
  size: i64(48),
  blksize: i64(56),
  blocks: i64(64),
  atime: timespec(72),
  mtime: timespec(88),
  ctime: timespec(104),
  birthtime: undefined,
};

/*
 * Linux aarch64 `struct stat` (asm-generic), 128 bytes:
 *   st_dev u64 @0   st_ino u64 @8   st_mode u32 @16   st_nlink u32 @20
 *   st_uid u32 @24   st_gid u32 @28   st_rdev u64 @32   pad @40   st_size i64 @48
 *   st_blksize i32 @56   pad @60   st_blocks i64 @64   atim @72  mtim @88  ctim @104
 */
const LINUX_ARM64_STAT: StatLayout = {
  bufferSize: 256,
  dev: u64(0),
  ino: u64(8),
  mode: u32(16),
  nlink: u32(20),
  uid: u32(24),
  gid: u32(28),
  rdev: u64(32),
  size: i64(48),
  blksize: i32(56),
  blocks: i64(64),
  atime: timespec(72),
  mtime: timespec(88),
  ctime: timespec(104),
  birthtime: undefined,
};

/** Linux 64-bit `struct dirent`: u64 d_ino @0, i64 d_off @8, u16 d_reclen @16, u8 d_type @18, d_name @19. */
const LINUX_DIRENT: DirentLayout = { typeOffset: 18, nameOffset: 19 };

function plainSymbols(): Record<LibcSymbol, readonly string[]> {
  // SAFETY: the loop gives every symbol of SYMBOLS exactly itself.
  const symbols = {} as Record<LibcSymbol, readonly string[]>;
  for (const symbol of SYMBOLS) symbols[symbol] = [symbol];
  return symbols;
}

function requireLittleEndian(): void {
  if (endianness() !== 'LE')
    throw new StableHandleError(
      'libc handle-relative I/O supports little-endian hosts only',
    );
}

/**
 * The profile that ships on macOS. `arch` is `process.arch`; Rosetta runs an
 * x64 Node against the x86_64 libSystem, so it follows the x64 row.
 */
export function darwinProfile(arch: string = process.arch): LibcAtProfile {
  requireLittleEndian();
  if (arch !== 'arm64' && arch !== 'x64')
    throw new StableHandleError(
      `Stable no-follow handles are unsupported on darwin/${arch}`,
    );
  const symbols = plainSymbols();
  if (arch === 'x64') {
    // x86_64 libSystem keeps a legacy 32-bit-inode entry under the bare name
    // and the layout above under `$INODE64`. arm64 has only the latter.
    // The layout check in handle-libc.ts rejects the bare name if it is the
    // legacy one.
    symbols.fstatat = ['fstatat$INODE64', 'fstatat'];
    symbols.fdopendir = ['fdopendir$INODE64', 'fdopendir'];
    symbols.readdir = ['readdir$INODE64', 'readdir'];
  }
  return {
    id: `darwin-${arch}`,
    // The canonical umbrella library. macOS 11+ keeps it in the dyld shared
    // cache, not on disk, and dlopen still answers for the path. The bare
    // names are the same library reached through the loader's search.
    libraries: [
      '/usr/lib/libSystem.B.dylib',
      '/usr/lib/libSystem.dylib',
      'libSystem.B.dylib',
    ],
    symbols,
    // <sys/fcntl.h>: AT_SYMLINK_NOFOLLOW 0x0020, AT_REMOVEDIR 0x0080,
    // O_CLOEXEC 0x01000000. Linux's values differ (0x100, 0x200, 0o2000000).
    atSymlinkNoFollow: 0x0020,
    atRemoveDir: 0x0080,
    openCloexec: 0x01000000,
    stat: DARWIN_STAT,
    dirent: DARWIN_DIRENT,
  };
}

/** glibc on Linux, so the same backend can be exercised where no Mac is at hand. */
export function linuxGlibcProfile(arch: string = process.arch): LibcAtProfile {
  requireLittleEndian();
  if (arch !== 'arm64' && arch !== 'x64')
    throw new StableHandleError(
      `The libc backend has no Linux layout for ${arch}`,
    );
  return {
    id: `linux-${arch}-glibc`,
    libraries: ['libc.so.6'],
    symbols: plainSymbols(),
    // <bits/fcntl-linux.h> and asm-generic/fcntl.h.
    atSymlinkNoFollow: 0x100,
    atRemoveDir: 0x200,
    openCloexec: 0o2000000,
    stat: arch === 'x64' ? LINUX_X64_STAT : LINUX_ARM64_STAT,
    dirent: LINUX_DIRENT,
  };
}

function readInt(buffer: Buffer, field: IntField): bigint {
  const { offset, width, signed } = field;
  if (offset + width > buffer.byteLength)
    throw new StableHandleError(
      `struct field at ${offset} is outside the ${buffer.byteLength}-byte buffer`,
    );
  if (width === 8)
    return signed
      ? buffer.readBigInt64LE(offset)
      : buffer.readBigUInt64LE(offset);
  if (width === 4)
    return BigInt(
      signed ? buffer.readInt32LE(offset) : buffer.readUInt32LE(offset),
    );
  return BigInt(
    signed ? buffer.readInt16LE(offset) : buffer.readUInt16LE(offset),
  );
}

/** What `struct stat` said, widened the way libuv widens it for Node. */
export interface DecodedStat {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly nlink: bigint;
  readonly uid: bigint;
  readonly gid: bigint;
  readonly rdev: bigint;
  readonly size: bigint;
  readonly blksize: bigint;
  readonly blocks: bigint;
  readonly atimeNs: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
  readonly birthtimeNs: bigint;
}

const NS_PER_SECOND = 1_000_000_000n;

function readTime(buffer: Buffer, field: TimeField): bigint {
  return (
    readInt(buffer, field.seconds) * NS_PER_SECOND +
    readInt(buffer, field.nanoseconds)
  );
}

/**
 * libuv copies every member into a uint64_t, so a narrower signed member
 * (Darwin's int32 `st_dev`) sign-extends; asUintN reproduces that, and Node's
 * BigIntStats of the same file then compares equal.
 */
export function decodeStat(buffer: Buffer, layout: StatLayout): DecodedStat {
  const wide = (field: IntField): bigint =>
    BigInt.asUintN(64, readInt(buffer, field));
  const ctimeNs = readTime(buffer, layout.ctime);
  return {
    dev: wide(layout.dev),
    ino: wide(layout.ino),
    mode: wide(layout.mode),
    nlink: wide(layout.nlink),
    uid: wide(layout.uid),
    gid: wide(layout.gid),
    rdev: wide(layout.rdev),
    size: readInt(buffer, layout.size),
    blksize: wide(layout.blksize),
    blocks: readInt(buffer, layout.blocks),
    atimeNs: readTime(buffer, layout.atime),
    mtimeNs: readTime(buffer, layout.mtime),
    ctimeNs,
    birthtimeNs:
      layout.birthtime === undefined
        ? ctimeNs
        : readTime(buffer, layout.birthtime),
  };
}

const NS_PER_MS = 1_000_000n;

/** `fs.BigIntStats` from a decoded `struct stat`. */
export function bigIntStatsFrom(decoded: DecodedStat): BigIntStats {
  const kind = decoded.mode & BigInt(constants.S_IFMT);
  const is = (type: number): boolean => kind === BigInt(type);
  const ms = (ns: bigint): bigint => ns / NS_PER_MS;
  const date = (ns: bigint): Date => new Date(Number(ms(ns)));
  return {
    dev: decoded.dev,
    mode: decoded.mode,
    nlink: decoded.nlink,
    uid: decoded.uid,
    gid: decoded.gid,
    rdev: decoded.rdev,
    blksize: decoded.blksize,
    ino: decoded.ino,
    size: decoded.size,
    blocks: decoded.blocks,
    atimeMs: ms(decoded.atimeNs),
    mtimeMs: ms(decoded.mtimeNs),
    ctimeMs: ms(decoded.ctimeNs),
    birthtimeMs: ms(decoded.birthtimeNs),
    atimeNs: decoded.atimeNs,
    mtimeNs: decoded.mtimeNs,
    ctimeNs: decoded.ctimeNs,
    birthtimeNs: decoded.birthtimeNs,
    atime: date(decoded.atimeNs),
    mtime: date(decoded.mtimeNs),
    ctime: date(decoded.ctimeNs),
    birthtime: date(decoded.birthtimeNs),
    isFile: () => is(constants.S_IFREG),
    isDirectory: () => is(constants.S_IFDIR),
    isSymbolicLink: () => is(constants.S_IFLNK),
    isBlockDevice: () => is(constants.S_IFBLK),
    isCharacterDevice: () => is(constants.S_IFCHR),
    isFIFO: () => is(constants.S_IFIFO),
    isSocket: () => is(constants.S_IFSOCK),
  };
}

/** What a directory entry is, as far as the project tools distinguish. */
export type EntryKind =
  | 'file'
  | 'directory'
  | 'symlink'
  | 'fifo'
  | 'socket'
  | 'character'
  | 'block'
  | 'unknown';

/**
 * d_type values (<dirent.h>). Identical on Linux and macOS; DT_WHT (14) is a
 * union-mount whiteout and reads as unknown.
 */
export function entryKindOfType(type: number): EntryKind {
  switch (type) {
    case 1:
      return 'fifo';
    case 2:
      return 'character';
    case 4:
      return 'directory';
    case 6:
      return 'block';
    case 8:
      return 'file';
    case 10:
      return 'symlink';
    case 12:
      return 'socket';
    default:
      return 'unknown';
  }
}

export function entryKindOfMode(mode: bigint): EntryKind {
  const kind = mode & BigInt(constants.S_IFMT);
  if (kind === BigInt(constants.S_IFREG)) return 'file';
  if (kind === BigInt(constants.S_IFDIR)) return 'directory';
  if (kind === BigInt(constants.S_IFLNK)) return 'symlink';
  if (kind === BigInt(constants.S_IFIFO)) return 'fifo';
  if (kind === BigInt(constants.S_IFSOCK)) return 'socket';
  if (kind === BigInt(constants.S_IFCHR)) return 'character';
  if (kind === BigInt(constants.S_IFBLK)) return 'block';
  return 'unknown';
}
