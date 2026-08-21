/**
 * Handle-relative filesystem I/O.
 *
 * POSIX: `/proc/self/fd/N` (Linux) or `/dev/fd/N` (macOS) so `open(join(that,
 * child))` is fd-relative. Windows has no procfs equivalent; child opens use
 * NtCreateFile with RootDirectory set to the parent OS handle (openat), never
 * GetFinalPathNameByHandle + a path re-walk.
 */

import { constants } from 'node:fs';
import {
  close as closeCb,
  fchmod as fchmodCb,
  fstat as fstatCb,
  fsync as fsyncCb,
  read as readCb,
  write as writeCb,
  type BigIntStats,
  type Dirent,
  type Stats,
} from 'node:fs';
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
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

export class StableHandleError extends Error {
  readonly code = 'UNSAFE_PATH';

  constructor(message: string) {
    super(message);
    this.name = 'StableHandleError';
  }
}

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
 * POSIX fd-relative path. On Windows this throws: child I/O must go through
 * `openChild` (NtCreateFile RootDirectory), not a re-walkable pathname.
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

export async function openChild(
  parent: FileHandle,
  name: string,
  flags: number,
  mode?: number,
): Promise<FileHandle> {
  assertHandleSegment(name);
  if (process.platform === 'win32')
    return windowsOpenChild(parent, name, flags, mode);
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
    try {
      await windowsOpenChild(
        parent,
        name,
        constants.O_RDONLY |
          constants.O_DIRECTORY |
          constants.O_CREAT |
          constants.O_EXCL,
      ).then(async (handle) => handle.close());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw error;
      throw error;
    }
    return;
  }
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
  await rm(posixChild(parent, name), {
    force: options.force ?? false,
    recursive: options.recursive ?? false,
  });
}

export async function lstatChild(
  parent: FileHandle,
  name: string,
): Promise<Stats | BigIntStats> {
  assertHandleSegment(name);
  if (process.platform === 'win32') {
    const handle = await windowsOpenChild(
      parent,
      name,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      return await handle.stat({ bigint: true });
    } finally {
      await handle.close();
    }
  }
  return lstat(posixChild(parent, name), { bigint: true });
}

export async function readDirChild(parent: FileHandle): Promise<string[]> {
  if (process.platform === 'win32') return windowsReadDir(parent);
  return readdir(stableHandlePath(parent));
}

export async function readDirChildWithTypes(
  parent: FileHandle,
): Promise<Dirent[]> {
  if (process.platform === 'win32') return windowsReadDirWithTypes(parent);
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
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  throw new StableHandleError(`Could not create unique directory under handle`);
}

const closeFd = promisify(closeCb);
const fsyncFd = promisify(fsyncCb);
const fchmodFd = promisify(fchmodCb);

function wrapFd(fd: number): FileHandle {
  const handle = {
    get fd() {
      return fd;
    },
    async close() {
      await closeFd(fd);
    },
    async stat(options?: { bigint?: boolean }) {
      return await new Promise<Stats | BigIntStats>((resolve, reject) => {
        if (options?.bigint === true) {
          fstatCb(fd, { bigint: true }, (error, stats) =>
            error ? reject(error) : resolve(stats),
          );
          return;
        }
        fstatCb(fd, (error, stats) => (error ? reject(error) : resolve(stats)));
      });
    },
    async sync() {
      await fsyncFd(fd);
    },
    async chmod(mode: number) {
      await fchmodFd(fd, mode);
    },
    async writeFile(contents: string | Uint8Array) {
      const bytes =
        typeof contents === 'string' ? Buffer.from(contents) : contents;
      let offset = 0;
      while (offset < bytes.byteLength) {
        const written = await new Promise<number>((resolve, reject) => {
          writeCb(
            fd,
            bytes,
            offset,
            bytes.byteLength - offset,
            offset,
            (error, n) => (error ? reject(error) : resolve(n)),
          );
        });
        if (written === 0) break;
        offset += written;
      }
    },
    async write(
      buffer: Uint8Array,
      offset = 0,
      length = buffer.byteLength - offset,
      position: number | null = null,
    ) {
      const bytesWritten = await new Promise<number>((resolve, reject) => {
        writeCb(fd, buffer, offset, length, position, (error, n) =>
          error ? reject(error) : resolve(n),
        );
      });
      return { bytesWritten, buffer };
    },
    async read(
      buffer: Uint8Array,
      offset: number,
      length: number,
      position: number | null,
    ) {
      const bytesRead = await new Promise<number>((resolve, reject) => {
        readCb(fd, buffer, offset, length, position, (error, n) =>
          error ? reject(error) : resolve(n),
        );
      });
      return { bytesRead, buffer };
    },
  };
  return handle as FileHandle;
}

function errno(code: string, message: string): NodeJS.ErrnoException {
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

type KoffiLib = {
  func: (sig: string) => (...args: never[]) => unknown;
};

type Koffi = {
  load: (name: string) => KoffiLib;
  struct: (name: string, def: Record<string, string>) => unknown;
  sizeof: (type: unknown) => number;
  pointer: (name: string, type: unknown) => unknown;
  opaque: () => unknown;
  encode: (buf: Buffer, type: unknown, value: unknown) => void;
};

let cachedNt: ReturnType<typeof loadNtApi> | undefined;

function loadNtApi() {
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
  const crt = loadCrt(koffi);
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
    NtCreateFile: ntdll.func(
      'int32 NtCreateFile(_Out_ void **FileHandle, uint32 DesiredAccess, void *ObjectAttributes, _Out_ void *IoStatusBlock, void *AllocationSize, uint32 FileAttributes, uint32 ShareAccess, uint32 CreateDisposition, uint32 CreateOptions, void *EaBuffer, uint32 EaLength)',
    ) as (...args: never[]) => number,
    NtSetInformationFile: ntdll.func(
      'int32 NtSetInformationFile(void *FileHandle, _Out_ void *IoStatusBlock, void *FileInformation, uint32 Length, uint32 FileInformationClass)',
    ) as (...args: never[]) => number,
    NtQueryDirectoryFile: ntdll.func(
      'int32 NtQueryDirectoryFile(void *FileHandle, void *Event, void *ApcRoutine, void *ApcContext, _Out_ void *IoStatusBlock, void *FileInformation, uint32 Length, uint32 FileInformationClass, uint8 ReturnSingleEntry, void *FileName, uint8 RestartScan)',
    ) as (...args: never[]) => number,
    CloseHandle: kernel32.func(
      'int32 __stdcall CloseHandle(void *hObject)',
    ) as (handle: unknown) => number,
    getOsFHandle: crt.func('void * __cdecl _get_osfhandle(int fd)') as (
      fd: number,
    ) => unknown,
    openOsFHandle: crt.func(
      'int __cdecl _open_osfhandle(void *osfhandle, int flags)',
    ) as (handle: unknown, flags: number) => number,
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
const FILE_TRAVERSE = 0x00000020;
const FILE_READ_ATTRIBUTES = 0x00000080;
const FileRenameInformation = 10;
const FileDispositionInformation = 13;
const FileDirectoryInformation = 1;
const _O_RDONLY = 0;
const _O_RDWR = 2;
const _O_BINARY = 0x8000;

function windowsOpenChild(
  parent: FileHandle,
  name: string,
  flags: number,
  _mode?: number,
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
  const outHandle = [null] as unknown[];
  const directory = (flags & constants.O_DIRECTORY) !== 0;
  const create = (flags & constants.O_CREAT) !== 0;
  const exclusive = (flags & constants.O_EXCL) !== 0;
  let access = SYNCHRONIZE | FILE_READ_ATTRIBUTES;
  if ((flags & constants.O_WRONLY) !== 0 || (flags & constants.O_RDWR) !== 0)
    access |= GENERIC_WRITE;
  if ((flags & constants.O_WRONLY) === 0) access |= GENERIC_READ;
  if (directory) access |= FILE_LIST_DIRECTORY | FILE_TRAVERSE;
  const disposition = create
    ? exclusive
      ? FILE_CREATE
      : FILE_OPEN_IF
    : FILE_OPEN;
  let options = FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT;
  options |= directory ? FILE_DIRECTORY_FILE : FILE_NON_DIRECTORY_FILE;
  const status = api.NtCreateFile(
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
  const crtFlags =
    _O_BINARY |
    ((flags & constants.O_RDWR) !== 0 || (flags & constants.O_WRONLY) !== 0
      ? _O_RDWR
      : _O_RDONLY);
  const fd = api.openOsFHandle(osHandle, crtFlags);
  if (fd < 0) {
    api.CloseHandle(osHandle);
    throw new StableHandleError(`_open_osfhandle failed for ${name}`);
  }
  return Promise.resolve(wrapFd(fd));
}

async function windowsRenameChild(
  parent: FileHandle,
  from: string,
  to: string,
): Promise<void> {
  const api = nt();
  const source = await windowsOpenChild(
    parent,
    from,
    constants.O_RDONLY | constants.O_NOFOLLOW,
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
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
      } catch (error) {
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
    const handle = await windowsOpenChild(
      parent,
      name,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const api = nt();
      const osHandle = api.getOsFHandle(handle.fd);
      const info = Buffer.alloc(1);
      info.writeUInt8(1, 0);
      const iosb = Buffer.alloc(16);
      const status = api.NtSetInformationFile(
        ...([osHandle, iosb, info, 1, FileDispositionInformation] as never[]),
      );
      if (ntStatus(status) !== STATUS_SUCCESS) throwNt(status, name);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (
      options.force === true &&
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

function loadKoffi(): Koffi {
  try {
    const url = Function('return import.meta.url')() as string;
    return createRequire(fileURLToPath(url))('koffi') as Koffi;
  } catch {
    const stack = new Error().stack ?? '';
    const match = /(?:file:\/\/)?(\/[^\s)]*handle-path\.js)/u.exec(stack);
    if (match?.[1]) return createRequire(match[1])('koffi') as Koffi;
    throw new StableHandleError(
      'Windows handle mapping could not locate this module to load koffi',
    );
  }
}

function loadCrt(koffi: Koffi): KoffiLib {
  const names = [
    'api-ms-win-crt-filesystem-l1-1-0.dll',
    'ucrtbase.dll',
    'msvcrt.dll',
  ];
  let last: unknown;
  for (const name of names) {
    try {
      return koffi.load(name);
    } catch (error) {
      last = error;
    }
  }
  throw new StableHandleError(
    `Windows handle mapping could not load CRT: ${String(last)}`,
  );
}
