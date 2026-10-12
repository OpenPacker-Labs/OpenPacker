/**
 * The libc backend's `symlinkat` and `readlinkat`, bound to glibc so the macOS
 * implementation of them runs on Linux: what it makes and reads, what it
 * refuses to trust, and the errors it raises (compared with the kernel's by
 * `handle-path.parity.test.ts`).
 */

import { constants } from 'node:fs';
import {
  lstat,
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
import { createLibcAtBackend } from './handle-libc.js';
import {
  linuxGlibcProfile,
  type LibcAtProfile,
} from './handle-libc-profile.js';
import { glibcLinux } from './handle-test-support.js';
import { StableHandleError } from './handle-support.js';

describe.skipIf(!glibcLinux())('libc symlinkat and readlinkat', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(await realpath(tmpdir()), 'handle-libc-link-'));
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
    const parent = await open(dir, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      return await run(createLibcAtBackend(profile), parent);
    } finally {
      await parent.close();
    }
  }

  const MEMBER = '../packages/pkg';

  it('makes a link, reads its text back, and agrees with fstatat', async () => {
    await withParent(linuxGlibcProfile(), async (backend, parent) => {
      await backend.symlinkChild(parent, 'made', MEMBER);

      expect(await backend.readlinkChild(parent, 'made')).toBe(MEMBER);
      const info = await backend.lstatChild(parent, 'made');
      expect(info.isSymbolicLink()).toBe(true);
      expect(info.size).toBe(BigInt(MEMBER.length));
      await backend.removeChild(parent, 'made', {});
    });
  });

  it('fails closed when symlinkat is missing, creating nothing', async () => {
    const real = linuxGlibcProfile();
    const profile: LibcAtProfile = {
      ...real,
      symbols: { ...real.symbols, symlinkat: ['opm_no_such_symbol'] },
    };
    await withParent(profile, async (backend, parent) => {
      await expect(
        backend.symlinkChild(parent, 'never', MEMBER),
      ).rejects.toThrow(/exports none of opm_no_such_symbol/u);
    });
    await expect(lstat(join(dir, 'never'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('fails closed when readlinkat is missing', async () => {
    const real = linuxGlibcProfile();
    const profile: LibcAtProfile = {
      ...real,
      symbols: { ...real.symbols, readlinkat: ['opm_no_such_symbol'] },
    };
    await withParent(profile, async (backend, parent) => {
      await expect(backend.readlinkChild(parent, 'file')).rejects.toThrow(
        /exports none of opm_no_such_symbol/u,
      );
    });
  });

  it('refuses a link when the first one it makes is not what fstatat sees, naming the call and the value, and removes it', async () => {
    const real = linuxGlibcProfile();
    // Without AT_SYMLINK_NOFOLLOW fstatat describes the target, not the link.
    const profile: LibcAtProfile = { ...real, atSymlinkNoFollow: 0 };
    await withParent(profile, async (backend, parent) => {
      const failure = await backend
        .symlinkChild(parent, 'checked', 'file')
        .catch((error: Error) => error);

      expect(failure).toBeInstanceOf(StableHandleError);
      expect((failure as Error).message).toMatch(
        /^libc symlinkat\/readlinkat "linux-.*-glibc" disagree: fstatat with AT_SYMLINK_NOFOLLOW \(0\) reported mode 0o100\d+, which is not a link$/u,
      );
    });
    await expect(lstat(join(dir, 'checked'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('checks the first link only; the same profile then works', async () => {
    await withParent(linuxGlibcProfile(), async (backend, parent) => {
      await backend.symlinkChild(parent, 'one', 'file');
      await backend.symlinkChild(parent, 'two', 'file');
      expect(await backend.readlinkChild(parent, 'two')).toBe('file');
      await backend.removeChild(parent, 'one', {});
      await backend.removeChild(parent, 'two', {});
    });
  });

  it('refuses a NUL in a target before any call', async () => {
    await withParent(linuxGlibcProfile(), async (backend, parent) => {
      await expect(
        backend.symlinkChild(parent, 'nul', 'a\0b'),
      ).rejects.toBeInstanceOf(StableHandleError);
    });
    await expect(lstat(join(dir, 'nul'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it.each([
    ['an existing name', 'file', 'EEXIST'],
    ['a missing directory entry under a file', undefined, 'ENOTDIR'],
  ])('says %s the way the kernel does', async (_label, name, code) => {
    await withParent(linuxGlibcProfile(), async (backend, parent) => {
      if (name !== undefined) {
        const failure = await backend
          .symlinkChild(parent, name, MEMBER)
          .catch((error: NodeJS.ErrnoException) => error);
        expect(failure).toMatchObject({ code, syscall: 'symlink' });
        expect((failure as Error).message).toBe(
          `EEXIST: file already exists, symlink '${MEMBER}' -> '${name}'`,
        );
        return;
      }
      const regular = await open(join(dir, 'file'), constants.O_RDONLY);
      try {
        await expect(
          backend.symlinkChild(regular, 'x', MEMBER),
        ).rejects.toMatchObject({ code, syscall: 'symlink' });
      } finally {
        await regular.close();
      }
    });
  });

  it.each([
    ['a file', 'file', 'EINVAL'],
    ['a directory', 'child', 'EINVAL'],
    ['nothing', 'absent', 'ENOENT'],
  ])('reads %s as %s', async (_label, name, code) => {
    await withParent(linuxGlibcProfile(), async (backend, parent) => {
      await expect(backend.readlinkChild(parent, name)).rejects.toMatchObject({
        code,
        syscall: 'readlink',
      });
    });
  });

  it('reports EBADF for a closed handle, rather than guessing a path', async () => {
    const parent = await open(dir, constants.O_RDONLY | constants.O_DIRECTORY);
    await parent.close();
    const backend = createLibcAtBackend(linuxGlibcProfile());
    await expect(
      backend.symlinkChild(parent, 'x', MEMBER),
    ).rejects.toMatchObject({ code: 'EBADF', syscall: 'symlink' });
    await expect(backend.readlinkChild(parent, 'x')).rejects.toMatchObject({
      code: 'EBADF',
      syscall: 'readlink',
    });
  });
});
