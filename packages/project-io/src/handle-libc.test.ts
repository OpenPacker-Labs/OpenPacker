import { constants } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLibcAtBackend, libcModuleFromStack } from './handle-libc.js';
import {
  bigIntStatsFrom,
  darwinProfile,
  decodeStat,
  entryKindOfMode,
  entryKindOfType,
  linuxGlibcProfile,
  type LibcAtProfile,
} from './handle-libc-profile.js';
import { glibcLinux } from './handle-test-support.js';
import { StableHandleError } from './handle-support.js';

describe('libcModuleFromStack', () => {
  it.each([
    [
      'an ESM frame',
      '    at loadKoffi (file:///home/u/pkg/dist/esm/handle-libc.js:120:15)',
      'file:///home/u/pkg/dist/esm/handle-libc.js',
    ],
    [
      'a CommonJS frame',
      '    at loadKoffi (/home/u/pkg/dist/cjs/handle-libc.js:120:15)',
      '/home/u/pkg/dist/cjs/handle-libc.js',
    ],
    [
      'a Windows CommonJS frame',
      '    at loadKoffi (D:\\a\\pkg\\dist\\cjs\\handle-libc.js:120:15)',
      'D:\\a\\pkg\\dist\\cjs\\handle-libc.js',
    ],
    [
      'a Windows ESM frame',
      '    at loadKoffi (file:///D:/a/pkg/dist/esm/handle-libc.js:120:15)',
      'file:///D:/a/pkg/dist/esm/handle-libc.js',
    ],
    [
      'a source frame',
      '    at loadKoffi (/home/u/pkg/src/handle-libc.ts:120:15)',
      '/home/u/pkg/src/handle-libc.ts',
    ],
    [
      'a frame with a space in its directory',
      '    at loadKoffi (/home/my user/pkg/src/handle-libc.ts:120:15)',
      '/home/my user/pkg/src/handle-libc.ts',
    ],
  ])('finds %s', (_label, stack, file) => {
    expect(
      libcModuleFromStack(`Error\n${stack}\n    at other (/x/y.js:1:1)`),
    ).toBe(file);
  });

  it('finds nothing in a stack that never entered the module', () => {
    expect(
      libcModuleFromStack('Error\n    at x (/home/u/handle-path.js:1:1)'),
    ).toBe(undefined);
  });
});

describe('struct stat decoding', () => {
  /** Builds the 144 bytes macOS writes for a regular file, from the documented layout. */
  function darwinStat(values: {
    dev: number;
    mode: number;
    ino: bigint;
  }): Buffer {
    const buffer = Buffer.alloc(256);
    buffer.writeInt32LE(values.dev, 0);
    buffer.writeUInt16LE(values.mode, 4);
    buffer.writeUInt16LE(3, 6);
    buffer.writeBigUInt64LE(values.ino, 8);
    buffer.writeUInt32LE(501, 16);
    buffer.writeUInt32LE(20, 20);
    buffer.writeInt32LE(0, 24);
    for (const [offset, seconds, nanoseconds] of [
      [32, 1_700_000_001n, 5n],
      [48, 1_700_000_002n, 6n],
      [64, 1_700_000_003n, 7n],
      [80, 1_600_000_000n, 8n],
    ] as const) {
      buffer.writeBigInt64LE(seconds, offset);
      buffer.writeBigInt64LE(nanoseconds, offset + 8);
    }
    buffer.writeBigInt64LE(1234n, 96);
    buffer.writeBigInt64LE(8n, 104);
    buffer.writeInt32LE(4096, 112);
    return buffer;
  }

  it('reads the macOS layout the way libuv widens it for Node', () => {
    const decoded = decodeStat(
      darwinStat({ dev: 0x1000004, mode: 0o100644, ino: 9_000_000_000n }),
      darwinProfile('arm64').stat,
    );
    expect(decoded).toMatchObject({
      dev: 0x1000004n,
      ino: 9_000_000_000n,
      mode: 0o100644n,
      nlink: 3n,
      uid: 501n,
      gid: 20n,
      size: 1234n,
      blocks: 8n,
      blksize: 4096n,
      atimeNs: 1_700_000_001_000_000_005n,
      mtimeNs: 1_700_000_002_000_000_006n,
      ctimeNs: 1_700_000_003_000_000_007n,
      birthtimeNs: 1_600_000_000_000_000_008n,
    });
    const stats = bigIntStatsFrom(decoded);
    expect(stats.isFile()).toBe(true);
    expect(stats.isDirectory()).toBe(false);
    expect(stats.mtimeMs).toBe(1_700_000_002_000n);
    expect(stats.mtime.getTime()).toBe(1_700_000_002_000);
  });

  it('sign-extends a negative 32-bit st_dev, as libuv does', () => {
    const decoded = decodeStat(
      darwinStat({ dev: -1, mode: 0o040755, ino: 2n }),
      darwinProfile('x64').stat,
    );
    expect(decoded.dev).toBe(0xffff_ffff_ffff_ffffn);
    expect(bigIntStatsFrom(decoded).isDirectory()).toBe(true);
  });

  it('refuses a field outside the buffer', () => {
    expect(() =>
      decodeStat(Buffer.alloc(16), darwinProfile('arm64').stat),
    ).toThrow(StableHandleError);
  });

  it('names file types from d_type and from a mode', () => {
    expect(
      [0, 1, 2, 4, 6, 8, 10, 12, 14].map((type) => entryKindOfType(type)),
    ).toEqual([
      'unknown',
      'fifo',
      'character',
      'directory',
      'block',
      'file',
      'symlink',
      'socket',
      'unknown',
    ]);
    expect(entryKindOfMode(BigInt(constants.S_IFLNK | 0o777))).toBe('symlink');
    expect(entryKindOfMode(BigInt(constants.S_IFDIR | 0o755))).toBe(
      'directory',
    );
  });
});

describe('profiles', () => {
  it('uses libSystem and the macOS values on both architectures', () => {
    for (const arch of ['arm64', 'x64']) {
      const profile = darwinProfile(arch);
      expect(profile.libraries[0]).toBe('/usr/lib/libSystem.B.dylib');
      expect(profile.atSymlinkNoFollow).toBe(0x20);
      expect(profile.atRemoveDir).toBe(0x80);
      expect(profile.openCloexec).toBe(0x01000000);
      expect(profile.stat.bufferSize).toBeGreaterThanOrEqual(144);
      expect(profile.dirent).toEqual({ typeOffset: 20, nameOffset: 21 });
    }
  });

  it('asks x86_64 macOS for the 64-bit-inode entry points first', () => {
    expect(darwinProfile('x64').symbols.fstatat).toEqual([
      'fstatat$INODE64',
      'fstatat',
    ]);
    expect(darwinProfile('x64').symbols.readdir[0]).toBe('readdir$INODE64');
    expect(darwinProfile('x64').symbols.fdopendir[0]).toBe('fdopendir$INODE64');
    expect(darwinProfile('arm64').symbols.fstatat).toEqual(['fstatat']);
  });

  it('binds symlinkat and readlinkat by their plain names on every target', () => {
    for (const profile of [
      darwinProfile('arm64'),
      darwinProfile('x64'),
      linuxGlibcProfile(),
    ]) {
      expect(profile.symbols.symlinkat).toEqual(['symlinkat']);
      expect(profile.symbols.readlinkat).toEqual(['readlinkat']);
    }
  });

  it('refuses an architecture it has no layout for', () => {
    expect(() => darwinProfile('ia32')).toThrow(StableHandleError);
    expect(() => linuxGlibcProfile('riscv64')).toThrow(StableHandleError);
  });
});

describe.skipIf(!glibcLinux())(
  'the backend refuses to trust what it cannot verify',
  () => {
    let dir: string;
    beforeAll(async () => {
      dir = await mkdtemp(join(await realpath(tmpdir()), 'handle-libc-'));
      await mkdir(join(dir, 'child'));
      await writeFile(join(dir, 'file'), 'x');
    });
    afterAll(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    async function withParent<T>(
      profile: LibcAtProfile,
      run: (
        backend: ReturnType<typeof createLibcAtBackend>,
        parent: Awaited<ReturnType<typeof open>>,
      ) => Promise<T>,
    ): Promise<T> {
      const parent = await open(
        dir,
        constants.O_RDONLY | constants.O_DIRECTORY,
      );
      try {
        return await run(createLibcAtBackend(profile), parent);
      } finally {
        await parent.close();
      }
    }

    it('works with the real glibc layout', async () => {
      await withParent(linuxGlibcProfile(), async (backend, parent) => {
        const stats = await backend.lstatChild(parent, 'file');
        expect(stats.isFile()).toBe(true);
        expect(await backend.readDirChild(parent)).toEqual(['child', 'file']);
      });
    });

    it('rejects a struct stat layout that disagrees with Node, saying which field', async () => {
      const real = linuxGlibcProfile();
      const wrong: LibcAtProfile = {
        ...real,
        stat: { ...real.stat, ino: { offset: 16, width: 8, signed: false } },
      };
      await withParent(wrong, async (backend, parent) => {
        const failure = await backend
          .lstatChild(parent, 'file')
          .catch((e: Error) => e);
        expect(failure).toBeInstanceOf(StableHandleError);
        expect((failure as StableHandleError).message).toMatch(
          /struct stat layout "linux-.*-glibc" disagrees with Node: .*\bino\b.*bytes [0-9a-f]{64}/u,
        );
      });
    });

    it('rejects a struct dirent layout that disagrees with Node', async () => {
      const real = linuxGlibcProfile();
      const wrong: LibcAtProfile = {
        ...real,
        dirent: {
          typeOffset: real.dirent.typeOffset,
          nameOffset: real.dirent.nameOffset + 1,
        },
      };
      await withParent(wrong, async (backend, parent) => {
        const failure = await backend
          .readDirChild(parent)
          .catch((e: Error) => e);
        expect(failure).toBeInstanceOf(StableHandleError);
        expect((failure as StableHandleError).message).toMatch(
          /struct dirent layout/u,
        );
      });
    });

    it('does not delete anything when its stat layout is wrong', async () => {
      const real = linuxGlibcProfile();
      const wrong: LibcAtProfile = {
        ...real,
        stat: { ...real.stat, mode: { offset: 0, width: 4, signed: false } },
      };
      await withParent(wrong, async (backend, parent) => {
        await expect(
          backend.removeChild(parent, 'child', { recursive: true }),
        ).rejects.toBeInstanceOf(StableHandleError);
        await expect(
          backend.removeChild(parent, 'file', {}),
        ).rejects.toBeInstanceOf(StableHandleError);
      });
      await withParent(linuxGlibcProfile(), async (backend, parent) => {
        expect(await backend.readDirChild(parent)).toEqual(['child', 'file']);
      });
    });

    it('fails closed when a symbol is missing', async () => {
      const real = linuxGlibcProfile();
      const profile: LibcAtProfile = {
        ...real,
        symbols: { ...real.symbols, mkdirat: ['opm_no_such_symbol'] },
      };
      await withParent(profile, async (backend, parent) => {
        await expect(backend.mkdirChild(parent, 'x')).rejects.toThrow(
          /exports none of opm_no_such_symbol: .*opm_no_such_symbol/u,
        );
      });
      await expect(
        open(join(dir, 'x')).catch(
          (error: NodeJS.ErrnoException) => error.code,
        ),
      ).resolves.toBe('ENOENT');
    });

    it('falls back to the next library name that loads', async () => {
      const profile: LibcAtProfile = {
        ...linuxGlibcProfile(),
        libraries: ['/nonexistent/libsystem.dylib', 'libc.so.6'],
      };
      await withParent(profile, async (backend, parent) => {
        expect((await backend.lstatChild(parent, 'file')).isFile()).toBe(true);
      });
    });

    it('prefers the first symbol that resolves', async () => {
      const real = linuxGlibcProfile();
      const profile: LibcAtProfile = {
        ...real,
        symbols: {
          ...real.symbols,
          fstatat: ['opm_no_such_symbol', 'fstatat'],
        },
      };
      await withParent(profile, async (backend, parent) => {
        expect((await backend.lstatChild(parent, 'file')).isFile()).toBe(true);
      });
    });

    it('fails closed when the library cannot be loaded', async () => {
      const profile: LibcAtProfile = {
        ...linuxGlibcProfile(),
        libraries: ['/nonexistent/libsystem.dylib', '/nonexistent/other.dylib'],
      };
      await withParent(profile, async (backend, parent) => {
        await expect(backend.readDirChild(parent)).rejects.toThrow(
          /could not load \/nonexistent\/libsystem\.dylib or \/nonexistent\/other\.dylib/u,
        );
      });
    });

    it('reports EBADF for a handle that is closed, rather than guessing a path', async () => {
      const parent = await open(
        dir,
        constants.O_RDONLY | constants.O_DIRECTORY,
      );
      await parent.close();
      const backend = createLibcAtBackend(linuxGlibcProfile());
      await expect(backend.mkdirChild(parent, 'x')).rejects.toMatchObject({
        code: 'EBADF',
        syscall: 'mkdir',
      });
    });
  },
);
