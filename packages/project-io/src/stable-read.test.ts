/**
 * The two reads other packages build on: a directory listing that stops at a
 * bound, and a path opened one retained ancestor at a time. `stable-read
 * .libc-at.test.ts` runs this file again with every POSIX child operation
 * routed through the libc `*at()` backend, which is what macOS uses.
 */

import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  openStablePath,
  readDirChildBounded,
  StableHandleError,
} from './index.js';

async function withTemp<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'stable-read-'));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function withDirectory<T>(
  path: string,
  run: (handle: Awaited<ReturnType<typeof open>>) => Promise<T>,
): Promise<T> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    return await run(handle);
  } finally {
    await handle.close();
  }
}

const mkfifoAvailable = ((): boolean => {
  try {
    execFileSync('mkfifo', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe('readDirChildBounded', () => {
  it('returns a directory within the bound whole, with each entry typed', async () => {
    await withTemp(async (dir) => {
      await writeFile(join(dir, 'file'), 'x');
      await mkdir(join(dir, 'folder'));
      await symlink('file', join(dir, 'link'));
      const listing = await withDirectory(dir, (handle) =>
        readDirChildBounded(handle, 3),
      );
      expect(listing.exceeded).toBe(false);
      const kinds = Object.fromEntries(
        listing.entries.map((entry) => [
          entry.name,
          entry.isFile()
            ? 'file'
            : entry.isDirectory()
              ? 'directory'
              : entry.isSymbolicLink()
                ? 'symlink'
                : 'other',
        ]),
      );
      expect(kinds).toEqual({
        file: 'file',
        folder: 'directory',
        link: 'symlink',
      });
    });
  });

  it('says an empty directory is within a bound of zero', async () => {
    await withTemp(async (dir) => {
      const listing = await withDirectory(dir, (handle) =>
        readDirChildBounded(handle, 0),
      );
      expect(listing).toEqual({ entries: [], exceeded: false });
    });
  });

  it('stops after the bound and says the directory holds more', async () => {
    await withTemp(async (dir) => {
      await Promise.all(
        ['a', 'b', 'c', 'd', 'e'].map((name) =>
          writeFile(join(dir, `${name}.tmp`), ''),
        ),
      );
      const listing = await withDirectory(dir, (handle) =>
        readDirChildBounded(handle, 2),
      );
      expect(listing.exceeded).toBe(true);
      expect(listing.entries).toHaveLength(2);
      for (const entry of listing.entries)
        expect(entry.name).toMatch(/\.tmp$/u);
    });
  });

  it('treats a directory of exactly the bound as within it', async () => {
    await withTemp(async (dir) => {
      await writeFile(join(dir, 'one'), '');
      await writeFile(join(dir, 'two'), '');
      const listing = await withDirectory(dir, (handle) =>
        readDirChildBounded(handle, 2),
      );
      expect(listing.exceeded).toBe(false);
      expect(listing.entries.map((entry) => entry.name).sort()).toEqual([
        'one',
        'two',
      ]);
    });
  });

  it('refuses a bound that is not a count', async () => {
    await withTemp(async (dir) => {
      await withDirectory(dir, async (handle) => {
        for (const bound of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
          await expect(readDirChildBounded(handle, bound)).rejects.toThrow(
            RangeError,
          );
      });
    });
  });

  it('keeps listing the retained directory after its pathname is replaced', async () => {
    await withTemp(async (dir) => {
      const tree = join(dir, 'tree');
      await mkdir(tree);
      await writeFile(join(tree, 'authorized'), '');
      await withDirectory(tree, async (handle) => {
        await rename(tree, join(dir, 'moved'));
        await mkdir(tree);
        await writeFile(join(tree, 'replacement'), '');
        const listing = await readDirChildBounded(handle, 4);
        expect(listing.entries.map((entry) => entry.name)).toEqual([
          'authorized',
        ]);
      });
    });
  });
});

describe('openStablePath', () => {
  it('opens a directory and a file through their ancestors', async () => {
    await withTemp(async (dir) => {
      await mkdir(join(dir, 'a', 'b'), { recursive: true });
      await writeFile(join(dir, 'a', 'b', 'file'), 'bytes');
      const folder = await openStablePath(join(dir, 'a', 'b'));
      try {
        expect((await folder.stat()).isDirectory()).toBe(true);
      } finally {
        await folder.close();
      }
      const file = await openStablePath(join(dir, 'a', 'b', 'file'), {
        allowFile: true,
      });
      try {
        expect((await file.stat()).size).toBe(5);
      } finally {
        await file.close();
      }
    });
  });

  it('opens the root', async () => {
    const root = await openStablePath('/');
    try {
      expect((await root.stat()).isDirectory()).toBe(true);
    } finally {
      await root.close();
    }
  });

  it('keeps naming the directory it opened after the pathname is replaced', async () => {
    await withTemp(async (dir) => {
      const tree = join(dir, 'tree');
      await mkdir(tree);
      await writeFile(join(tree, 'authorized'), '');
      const handle = await openStablePath(tree);
      try {
        await rename(tree, join(dir, 'moved'));
        await mkdir(tree);
        const listing = await readDirChildBounded(handle, 4);
        expect(listing.entries.map((entry) => entry.name)).toEqual([
          'authorized',
        ]);
      } finally {
        await handle.close();
      }
    });
  });

  it('creates nothing', async () => {
    await withTemp(async (dir) => {
      await expect(
        openStablePath(join(dir, 'missing', 'deeper')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(openStablePath(join(dir, 'missing'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(await readdir(dir)).toEqual([]);
    });
  });

  it('refuses a symlink in the middle of the path and at the end', async () => {
    await withTemp(async (dir) => {
      await mkdir(join(dir, 'real'));
      await writeFile(join(dir, 'real', 'file'), '');
      await symlink(join(dir, 'real'), join(dir, 'alias'));
      await symlink(join(dir, 'real', 'file'), join(dir, 'filelink'));
      const code = async (run: Promise<unknown>): Promise<string> =>
        run.then(
          () => 'opened',
          (error: NodeJS.ErrnoException) => error.code ?? 'failed',
        );
      expect(['ELOOP', 'ENOTDIR']).toContain(
        await code(
          openStablePath(join(dir, 'alias', 'file'), { allowFile: true }),
        ),
      );
      expect(['ELOOP', 'ENOTDIR']).toContain(
        await code(openStablePath(join(dir, 'alias'))),
      );
      expect(['ELOOP', 'ENOTDIR']).toContain(
        await code(openStablePath(join(dir, 'filelink'), { allowFile: true })),
      );
    });
  });

  it('refuses a file unless a file was allowed', async () => {
    await withTemp(async (dir) => {
      await writeFile(join(dir, 'file'), '');
      await expect(openStablePath(join(dir, 'file'))).rejects.toMatchObject({
        code: expect.stringMatching(/^(ENOTDIR|UNSAFE_PATH)$/u),
      });
    });
  });

  it.skipIf(!mkfifoAvailable)(
    'refuses a FIFO named as the last component without blocking on it',
    async () => {
      await withTemp(async (dir) => {
        execFileSync('mkfifo', [join(dir, 'pipe')]);
        await expect(
          openStablePath(join(dir, 'pipe'), { allowFile: true }),
        ).rejects.toBeInstanceOf(StableHandleError);
      });
    },
  );

  it('refuses a path that is not absolute', async () => {
    await expect(openStablePath('relative/path')).rejects.toBeInstanceOf(
      StableHandleError,
    );
  });
});
