/**
 * Handle-relative filesystem I/O.
 *
 * Every child operation names a child of an open directory descriptor and
 * never re-walks a path, so a swapped ancestor cannot redirect it:
 *
 * - Linux: `/proc/self/fd/N` is a magic link to the open directory, so
 *   `open(join(that, child))` is fd-relative. Ordinary fs calls do the work.
 * - macOS: `/dev/fd/N` is a file-descriptor filesystem, not a link.
 *   `/dev/fd/N/child` does not resolve (ENOENT/ENOTDIR), so the child
 *   operations go through libc `openat`/`mkdirat`/`renameat`/`unlinkat`/
 *   `fstatat` bound with koffi (`handle-libc.ts`, ADR 0045). `/dev/fd/N` still
 *   names the descriptor's own file when a caller only needs to re-open it.
 * - Windows has no procfs equivalent; child opens use NtCreateFile with
 *   RootDirectory set to the parent OS handle (openat), never
 *   GetFinalPathNameByHandle + a path re-walk.
 */

import { constants } from 'node:fs';
import { type BigIntStats, type Dirent } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  type FileHandle,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { createLibcAtBackend, type ChildBackend } from './handle-libc.js';
import { darwinProfile } from './handle-libc-profile.js';
import {
  StableHandleError,
  locateModuleFile,
  wrapFd,
} from './handle-support.js';

/**
 * `O_DIRECTORY` where the platform has one, and a private bit where it does not.
 *
 * Windows has no `O_DIRECTORY`: `fs.constants.O_DIRECTORY` is undefined there, so
 * `O_RDONLY | constants.O_DIRECTORY` silently asks for any object, and an NT open
 * cannot tell that a directory was wanted. `mkdirChild` then created a file, and
 * the open of a directory failed with EISDIR. Callers name the directory bit
 * through this constant. The private bit is one libuv ignores.
 */
export const O_DIRECTORY: number = constants.O_DIRECTORY ?? 0x0020_0000;

/**
 * Internal to the NT backend: open whatever the name is, file or directory.
 * Statting, renaming and deleting a child do not know its kind, and asking NT
 * for one kind fails on the other (EISDIR for a directory opened as a file).
 * Not exported, so no caller can set it.
 */
const ANY_KIND = 0x0040_0000;

export { StableHandleError };

const SUPPORTED = new Set<NodeJS.Platform>(['linux', 'darwin', 'win32']);

export function supportsStableHandles(
  platform: NodeJS.Platform = process.platform,
): boolean {
  return SUPPORTED.has(platform);
}

export function handlePathForPlatform(
  fd: number,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === 'linux') return `/proc/self/fd/${fd}`;
  if (platform === 'darwin') return `/dev/fd/${fd}`;
  if (platform === 'win32') return windowsNtHandlePathForm(fd);
  throw new StableHandleError(
    'Stable no-follow filesystem handles are unavailable on this platform',
  );
}

/**
 * The pathname of an open descriptor: `/proc/self/fd/N` on Linux, `/dev/fd/N`
 * on macOS. On Linux, children of it resolve fd-relatively; on macOS only the
 * descriptor itself does (an `open` of it duplicates the descriptor), so child
 * I/O goes through `openChild` and its siblings, never `join(path, child)`.
 * On Windows this throws: child I/O must go through `openChild` (NtCreateFile
 * RootDirectory), not a re-walkable pathname.
 */
export function stableHandlePath(
  handle: FileHandle,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === 'win32')
    throw new StableHandleError(
      'Windows I/O must use openChild (NtCreateFile RootDirectory), not a handle path',
    );
  return handlePathForPlatform(handle.fd, platform);
}

/** Test/display form only — never passed to fs.open on Windows. */
export function windowsNtHandlePathForm(fd: number): string {
  return `\\\\?\\GLOBALROOT\\Handle\\${fd}`;
}

export function assertHandleSegment(name: string): string {
  if (
    name === '' ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\\') ||
    name.includes('\0')
  )
    throw new StableHandleError(`Refusing handle-relative segment "${name}"`);
  return name;
}

function posixChild(parent: FileHandle, name: string): string {
  return join(stableHandlePath(parent), assertHandleSegment(name));
}

/** Which mechanism turns "child of this descriptor" into a syscall. */
export type ChildBackendKind = 'proc-fd' | 'libc-at' | 'nt' | 'unsupported';

/**
 * The backend a platform uses. Only Linux resolves `/proc/self/fd/N/child`;
 * macOS uses the libc `*at()` calls, Windows the NT calls, and anything else
 * is refused rather than guessed.
 */
export function childBackendKind(
  platform: NodeJS.Platform = process.platform,
): ChildBackendKind {
  if (platform === 'linux') return 'proc-fd';
  if (platform === 'darwin') return 'libc-at';
  if (platform === 'win32') return 'nt';
  return 'unsupported';
}

let darwinBackend: ChildBackend | undefined;
let testBackend: ChildBackend | undefined;

/**
 * Run every POSIX child operation through `backend` until the returned
 * function is called. Tests use it to drive the libc implementation against
 * glibc and to compare it with /proc/self/fd. It is not re-exported from the
 * package entry, no environment variable reaches it, and win32 ignores it.
 */
export function useChildBackendForTesting(backend: ChildBackend): () => void {
  const previous = testBackend;
  testBackend = backend;
  return () => {
    testBackend = previous;
  };
}

/**
 * The libc backend for this call, or undefined to use /proc/self/fd. The
 * platform is read at call time, as the Windows branch always has been.
 */
function libcBackend(): ChildBackend | undefined {
  const kind = childBackendKind(process.platform);
  if (kind === 'nt') return undefined;
  if (testBackend !== undefined) return testBackend;
  if (kind !== 'libc-at') return undefined;
  darwinBackend ??= createLibcAtBackend(darwinProfile(process.arch));
  return darwinBackend;
}

export async function openChild(
  parent: FileHandle,
  name: string,
  flags: number,
  mode?: number,
): Promise<FileHandle> {
  assertHandleSegment(name);
  if (process.platform === 'win32')
    return windowsOpenChild(parent, name, flags, mode);
  const libc = libcBackend();
  if (libc !== undefined) return libc.openChild(parent, name, flags, mode);
  return mode === undefined
    ? open(posixChild(parent, name), flags)
    : open(posixChild(parent, name), flags, mode);
}

export async function mkdirChild(
  parent: FileHandle,
  name: string,
): Promise<void> {
  assertHandleSegment(name);
  if (process.platform === 'win32') {
    const handle = await windowsOpenChild(
      parent,
      name,
      constants.O_RDONLY | O_DIRECTORY | constants.O_CREAT | constants.O_EXCL,
    );
    await handle.close();
    return;
  }
  const libc = libcBackend();
  if (libc !== undefined) return libc.mkdirChild(parent, name);
  await mkdir(posixChild(parent, name));
}

export async function renameChild(
  parent: FileHandle,
  from: string,
  to: string,
): Promise<void> {
  assertHandleSegment(from);
  assertHandleSegment(to);
  if (process.platform === 'win32') {
    await windowsRenameChild(parent, from, to);
    return;
  }
  const libc = libcBackend();
  if (libc !== undefined) return libc.renameChild(parent, from, to);
  await rename(posixChild(parent, from), posixChild(parent, to));
}

export async function removeChild(
  parent: FileHandle,
  name: string,
  options: { recursive?: boolean; force?: boolean } = {},
): Promise<void> {
  assertHandleSegment(name);
  if (process.platform === 'win32') {
    await windowsRemoveChild(parent, name, options);
    return;
  }
  const libc = libcBackend();
  if (libc !== undefined) return libc.removeChild(parent, name, options);
  await rm(posixChild(parent, name), {
    force: options.force ?? false,
    recursive: options.recursive ?? false,
  });
}

export async function lstatChild(
  parent: FileHandle,
  name: string,
): Promise<BigIntStats> {
  assertHandleSegment(name);
  if (process.platform === 'win32') {
    const handle = await windowsOpenChild(
      parent,
      name,
      constants.O_RDONLY | constants.O_NOFOLLOW | ANY_KIND,
    );
    try {
      return await handle.stat({ bigint: true });
    } finally {
      await handle.close();
    }
  }
  const libc = libcBackend();
  if (libc !== undefined) return libc.lstatChild(parent, name);
  return lstat(posixChild(parent, name), { bigint: true });
}

export async function readDirChild(parent: FileHandle): Promise<string[]> {
  if (process.platform === 'win32') return windowsReadDir(parent);
  const libc = libcBackend();
  if (libc !== undefined) return libc.readDirChild(parent);
  return readdir(stableHandlePath(parent));
}

export async function readDirChildWithTypes(
  parent: FileHandle,
): Promise<Dirent[]> {
  if (process.platform === 'win32') return windowsReadDirWithTypes(parent);
  const libc = libcBackend();
  if (libc !== undefined) return libc.readDirChildWithTypes(parent);
  return readdir(stableHandlePath(parent), { withFileTypes: true });
}

export async function mkdtempChild(
  parent: FileHandle,
  prefix: string,
): Promise<string> {
  assertHandleSegment(prefix.replace(/-+$/u, '') || 'tmp');
  for (let i = 0; i < 64; i += 1) {
    const name = `${prefix}${Math.random().toString(16).slice(2, 10)}`;
    try {
      await mkdirChild(parent, name);
      return name;
    } catch (error) {
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  throw new StableHandleError(`Could not create unique directory under handle`);
}

function errno(code: string, message: string): NodeJS.ErrnoException {
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

function ntStatus(code: number): number {
  return code >>> 0;
}

const STATUS_SUCCESS = 0;
const STATUS_OBJECT_NAME_COLLISION = 0xc0000035;
const STATUS_OBJECT_NAME_NOT_FOUND = 0xc0000034;
const STATUS_OBJECT_PATH_NOT_FOUND = 0xc000003a;
const STATUS_STOPPED_ON_SYMLINK = 0x8000002d;
const STATUS_REPARSE = 0x00000104;
const STATUS_NOT_A_DIRECTORY = 0xc0000103;
const STATUS_FILE_IS_A_DIRECTORY = 0xc00000ba;
const STATUS_NO_MORE_FILES = 0x80000006;
const STATUS_ACCESS_DENIED = 0xc0000022;

function throwNt(status: number, name: string): never {
  const code = ntStatus(status);
  if (code === STATUS_OBJECT_NAME_COLLISION)
    throw errno('EEXIST', `EEXIST: ${name}`);
  if (
    code === STATUS_OBJECT_NAME_NOT_FOUND ||
    code === STATUS_OBJECT_PATH_NOT_FOUND
  )
    throw errno('ENOENT', `ENOENT: ${name}`);
  if (code === STATUS_STOPPED_ON_SYMLINK || code === STATUS_REPARSE)
    throw errno('ELOOP', `ELOOP: ${name}`);
  if (code === STATUS_NOT_A_DIRECTORY)
    throw errno('ENOTDIR', `ENOTDIR: ${name}`);
  if (code === STATUS_FILE_IS_A_DIRECTORY)
    throw errno('EISDIR', `EISDIR: ${name}`);
  if (code === STATUS_ACCESS_DENIED) throw errno('EACCES', `EACCES: ${name}`);
  throw new StableHandleError(
    `NtCreateFile failed for ${name} with status 0x${code.toString(16)}`,
  );
}

interface KoffiHandle {}

type KoffiValue = number | string | Uint8Array | KoffiHandle | null | undefined;

type KoffiLib = {
  func: (sig: string) => (...args: never[]) => KoffiValue;
};

type Koffi = {
  load: (name: string) => KoffiLib;
  struct: (name: string, def: Record<string, string>) => KoffiHandle;
  sizeof: (type: KoffiHandle) => number;
  pointer: (name: string, type: KoffiHandle) => KoffiHandle;
  opaque: () => KoffiHandle;
  encode: (buf: Buffer, type: KoffiHandle, value: KoffiValue) => void;
};

let cachedNt: ReturnType<typeof loadNtApi> | undefined;

function loadNtApi() {
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  const koffi = loadKoffi() as Koffi;
  const HANDLE = koffi.pointer('HANDLE', koffi.opaque());
  const UNICODE_STRING = koffi.struct('UNICODE_STRING', {
    Length: 'uint16',
    MaximumLength: 'uint16',
    Buffer: 'void *',
  });
  const OBJECT_ATTRIBUTES = koffi.struct('OBJECT_ATTRIBUTES', {
    Length: 'uint32',
    RootDirectory: 'void *',
    ObjectName: 'void *',
    Attributes: 'uint32',
    SecurityDescriptor: 'void *',
    SecurityQualityOfService: 'void *',
  });
  const IO_STATUS_BLOCK = koffi.struct('IO_STATUS_BLOCK', {
    Pointer: 'void *',
    Information: 'uintptr_t',
  });
  // Variable-length FileName is appended manually at offset 20.
  const FILE_RENAME_INFORMATION = koffi.struct('FILE_RENAME_INFORMATION', {
    ReplaceIfExists: 'uint8',
    RootDirectory: 'void *',
    FileNameLength: 'uint32',
  });
  const ntdll = koffi.load('ntdll.dll');
  const kernel32 = koffi.load('kernel32.dll');
  const host = loadNodeHost(koffi);
  return {
    koffi,
    HANDLE,
    UNICODE_STRING,
    OBJECT_ATTRIBUTES,
    IO_STATUS_BLOCK,
    FILE_RENAME_INFORMATION,
    sizeofOa: koffi.sizeof(OBJECT_ATTRIBUTES),
    sizeofUni: koffi.sizeof(UNICODE_STRING),
    sizeofRename: koffi.sizeof(FILE_RENAME_INFORMATION),
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    NtCreateFile: ntdll.func(
      'int32 NtCreateFile(_Out_ void **FileHandle, uint32 DesiredAccess, void *ObjectAttributes, _Out_ void *IoStatusBlock, void *AllocationSize, uint32 FileAttributes, uint32 ShareAccess, uint32 CreateDisposition, uint32 CreateOptions, void *EaBuffer, uint32 EaLength)',
    ) as (...args: never[]) => number,
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    NtSetInformationFile: ntdll.func(
      'int32 NtSetInformationFile(void *FileHandle, _Out_ void *IoStatusBlock, void *FileInformation, uint32 Length, uint32 FileInformationClass)',
    ) as (...args: never[]) => number,
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    NtQueryDirectoryFile: ntdll.func(
      'int32 NtQueryDirectoryFile(void *FileHandle, void *Event, void *ApcRoutine, void *ApcContext, _Out_ void *IoStatusBlock, void *FileInformation, uint32 Length, uint32 FileInformationClass, uint8 ReturnSingleEntry, void *FileName, uint8 RestartScan)',
    ) as (...args: never[]) => number,
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    CloseHandle: kernel32.func(
      'int32 __stdcall CloseHandle(void *hObject)',
    ) as (handle: unknown) => number,
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    getOsFHandle: host.func('void * __cdecl uv_get_osfhandle(int fd)') as (
      fd: number,
    ) => KoffiHandle,
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    openOsFHandle: host.func('int __cdecl uv_open_osfhandle(void *os_fd)') as (
      handle: unknown,
    ) => number,
  };
}

function nt(): ReturnType<typeof loadNtApi> {
  cachedNt ??= loadNtApi();
  return cachedNt;
}

const OBJ_CASE_INSENSITIVE = 0x00000040;
const OBJ_DONT_REPARSE = 0x00001000;
const FILE_SHARE_ALL = 0x00000007;
const FILE_ATTRIBUTE_NORMAL = 0x00000080;
const FILE_ATTRIBUTE_DIRECTORY = 0x00000010;
const FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;
const FILE_OPEN = 1;
const FILE_CREATE = 2;
const FILE_OPEN_IF = 3;
const FILE_DIRECTORY_FILE = 0x00000001;
const FILE_NON_DIRECTORY_FILE = 0x00000040;
const FILE_SYNCHRONOUS_IO_NONALERT = 0x00000020;
const FILE_OPEN_REPARSE_POINT = 0x00200000;
const DELETE = 0x00010000;
const SYNCHRONIZE = 0x00100000;
const GENERIC_READ = 0x80000000;
const GENERIC_WRITE = 0x40000000;
const FILE_LIST_DIRECTORY = 0x00000001;
const FILE_ADD_FILE = 0x00000002;
const FILE_ADD_SUBDIRECTORY = 0x00000004;
const FILE_TRAVERSE = 0x00000020;
const FILE_DELETE_CHILD = 0x00000040;
const FILE_READ_ATTRIBUTES = 0x00000080;
const FileRenameInformation = 10;
const FileDispositionInformation = 13;
const FileDirectoryInformation = 1;

function windowsOpenChild(
  parent: FileHandle,
  name: string,
  flags: number,
  _mode?: number,
  extraAccess = 0,
): Promise<FileHandle> {
  const api = nt();
  const root = api.getOsFHandle(parent.fd);
  if (root === null || root === undefined || root === -1)
    throw new StableHandleError(`Windows CRT fd ${parent.fd} has no OS handle`);
  const nameW = Buffer.from(`${name}\0`, 'utf16le');
  const uni = Buffer.alloc(api.sizeofUni);
  api.koffi.encode(uni, api.UNICODE_STRING, {
    Length: name.length * 2,
    MaximumLength: nameW.length,
    Buffer: nameW,
  });
  const oa = Buffer.alloc(api.sizeofOa);
  api.koffi.encode(oa, api.OBJECT_ATTRIBUTES, {
    Length: api.sizeofOa,
    RootDirectory: root,
    ObjectName: uni,
    Attributes: OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE,
    SecurityDescriptor: null,
    SecurityQualityOfService: null,
  });
  const iosb = Buffer.alloc(16);
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  const outHandle = [null] as unknown[];
  const directory = (flags & O_DIRECTORY) !== 0;
  const create = (flags & constants.O_CREAT) !== 0;
  const exclusive = (flags & constants.O_EXCL) !== 0;
  let access = SYNCHRONIZE | FILE_READ_ATTRIBUTES | extraAccess;
  if ((flags & constants.O_WRONLY) !== 0 || (flags & constants.O_RDWR) !== 0)
    access |= GENERIC_WRITE;
  if ((flags & constants.O_WRONLY) === 0) access |= GENERIC_READ;
  // Directory handles double as mutation parents (mkdir / mkdtemp / create /
  // rename / remove children), and the NT object manager checks the
  // child-management rights on the RootDirectory handle. Requesting them on a
  // genuinely write-denied directory fails closed with EACCES rather than
  // degrading containment; pure reads of normally ACL'd trees are unaffected.
  if (directory)
    access |=
      FILE_LIST_DIRECTORY |
      FILE_TRAVERSE |
      FILE_ADD_FILE |
      FILE_ADD_SUBDIRECTORY |
      FILE_DELETE_CHILD;
  const disposition = create
    ? exclusive
      ? FILE_CREATE
      : FILE_OPEN_IF
    : FILE_OPEN;
  let options = FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT;
  if ((flags & ANY_KIND) === 0)
    options |= directory ? FILE_DIRECTORY_FILE : FILE_NON_DIRECTORY_FILE;
  const status = api.NtCreateFile(
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    ...([
      outHandle,
      access,
      oa,
      iosb,
      null,
      FILE_ATTRIBUTE_NORMAL,
      FILE_SHARE_ALL,
      disposition,
      options,
      null,
      0,
    ] as never[]),
  );
  if (ntStatus(status) !== STATUS_SUCCESS) throwNt(status, name);
  const osHandle = outHandle[0];
  const fd = api.openOsFHandle(osHandle);
  if (fd < 0) {
    api.CloseHandle(osHandle);
    throw new StableHandleError(`uv_open_osfhandle failed for ${name}`);
  }
  return Promise.resolve(wrapFd(fd));
}

async function windowsRenameChild(
  parent: FileHandle,
  from: string,
  to: string,
): Promise<void> {
  const api = nt();
  // FileRenameInformation requires DELETE access on the handle being renamed.
  const source = await windowsOpenChild(
    parent,
    from,
    constants.O_RDONLY | constants.O_NOFOLLOW | ANY_KIND,
    undefined,
    DELETE,
  );
  try {
    const osHandle = api.getOsFHandle(source.fd);
    const parentOsHandle = api.getOsFHandle(parent.fd);
    const nameW = Buffer.from(to, 'utf16le');
    // RootDirectory is the parent OS handle, so the relative target name
    // stays handle-relative and never re-walks a path from the object-manager
    // root. Struct encoding keeps the opaque koffi pointer intact.
    const info = Buffer.alloc(api.sizeofRename + nameW.length);
    api.koffi.encode(info, api.FILE_RENAME_INFORMATION, {
      ReplaceIfExists: 1,
      RootDirectory: parentOsHandle,
      FileNameLength: nameW.length,
    });
    nameW.copy(info, 20); // offset of FileName after BOOLEAN + pad + HANDLE + ULONG
    const iosb = Buffer.alloc(16);
    const status = api.NtSetInformationFile(
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      ...([
        osHandle,
        iosb,
        info,
        info.length,
        FileRenameInformation,
      ] as never[]),
    );
    if (ntStatus(status) !== STATUS_SUCCESS) throwNt(status, to);
  } finally {
    await source.close();
  }
}

async function windowsRemoveChild(
  parent: FileHandle,
  name: string,
  options: { recursive?: boolean; force?: boolean },
): Promise<void> {
  try {
    if (options.recursive === true) {
      let dir: FileHandle | undefined;
      try {
        dir = await windowsOpenChild(
          parent,
          name,
          constants.O_RDONLY | O_DIRECTORY | constants.O_NOFOLLOW,
        );
      } catch (error) {
        // SAFETY: The surrounding boundary establishes the asserted domain contract.
        if ((error as NodeJS.ErrnoException).code !== 'ENOTDIR') throw error;
      }
      if (dir) {
        try {
          for (const child of await windowsReadDir(dir))
            await windowsRemoveChild(dir, child, {
              recursive: true,
              force: true,
            });
        } finally {
          await dir.close();
        }
      }
    }
    // FileDispositionInformation requires DELETE access on the handle.
    const handle = await windowsOpenChild(
      parent,
      name,
      constants.O_RDONLY | constants.O_NOFOLLOW | ANY_KIND,
      undefined,
      DELETE,
    );
    try {
      const api = nt();
      const osHandle = api.getOsFHandle(handle.fd);
      const info = Buffer.alloc(1);
      info.writeUInt8(1, 0);
      const iosb = Buffer.alloc(16);
      const status = api.NtSetInformationFile(
        // SAFETY: The surrounding boundary establishes the asserted domain contract.
        ...([osHandle, iosb, info, 1, FileDispositionInformation] as never[]),
      );
      if (ntStatus(status) !== STATUS_SUCCESS) throwNt(status, name);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (
      options.force === true &&
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    )
      return;
    throw error;
  }
}

async function windowsReadDir(parent: FileHandle): Promise<string[]> {
  return (await windowsReadDirWithTypes(parent)).map((entry) => entry.name);
}

async function windowsReadDirWithTypes(parent: FileHandle): Promise<Dirent[]> {
  const api = nt();
  const osHandle = api.getOsFHandle(parent.fd);
  const buffer = Buffer.alloc(16 * 1024);
  const iosb = Buffer.alloc(16);
  const entries: Dirent[] = [];
  let restart = 1;
  for (;;) {
    const status = api.NtQueryDirectoryFile(
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
    );
    restart = 0;
    const code = ntStatus(status);
    if (code === STATUS_NO_MORE_FILES) break;
    if (code !== STATUS_SUCCESS) throwNt(status, '<directory>');
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
      if (name !== '.' && name !== '..')
        entries.push(ntDirent(name, attributes));
      if (next === 0) break;
      offset += next;
    }
  }
  return entries;
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

/** Where this module was loaded from, in a form `createRequire` accepts. */
export function moduleFileFromStack(stack: string): string | undefined {
  return locateModuleFile(stack, 'handle-path');
}

function loadKoffi(): Koffi {
  const file = moduleFileFromStack(new Error().stack ?? '');
  if (file === undefined) {
    throw new StableHandleError(
      'Windows handle mapping could not locate this module to load koffi',
    );
  }
  // SAFETY: koffi is this package's own dependency; the cast names its shape.
  return createRequire(file)('koffi') as Koffi;
}

/**
 * The library that owns Node's file descriptors, which is node.exe itself.
 *
 * node.exe links its own copy of the C runtime, so a descriptor Node hands out
 * means nothing to the system UCRT: asking `_get_osfhandle` about it trips the
 * invalid-parameter handler, and the process dies with no JavaScript error.
 * libuv exports the two conversions that use the right table, as
 * `uv_get_osfhandle` and `uv_open_osfhandle`, so they are called from here.
 */
function loadNodeHost(koffi: Koffi): KoffiLib {
  try {
    return koffi.load(process.execPath);
  } catch (error) {
    throw new StableHandleError(
      `Windows handle mapping could not load libuv from ${process.execPath}: ${String(error)}`,
    );
  }
}
