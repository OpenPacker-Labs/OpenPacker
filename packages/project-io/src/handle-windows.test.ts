import { constants } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  StableHandleError,
  lstatChild,
  mkdirChild,
  openChild,
  readDirChild,
  removeChild,
  renameChild,
} from './handle-path.js';
import { openStableDirectory } from './index.js';

/**
 * Windows has no procfs, so every child operation is an NtCreateFile with the
 * parent handle as RootDirectory, reached through koffi. Linux and macOS never
 * load that path, so this runs only where it is the real thing; the CI build
 * matrix runs it on its Windows legs.
 */
describe.skipIf(process.platform !== 'win32')(
  'handle-relative I/O through NT handles',
  () => {
    it('creates, lists, stats, renames and removes children of an open directory', async () => {
      const base = await mkdtemp(join(tmpdir(), 'opm-nt-'));
      const dir = await openStableDirectory(base);
      try {
        await mkdirChild(dir, 'sub');
        const file = await openChild(
          dir,
          'a.txt',
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
          0o644,
        );
        await file.writeFile('hello');
        await file.close();

        expect((await readDirChild(dir)).sort()).toEqual(['a.txt', 'sub']);
        expect(Number((await lstatChild(dir, 'a.txt')).size)).toBe(5);

        await renameChild(dir, 'a.txt', 'b.txt');
        expect((await readDirChild(dir)).sort()).toEqual(['b.txt', 'sub']);

        await removeChild(dir, 'b.txt', {});
        await removeChild(dir, 'sub', { recursive: true });
        expect(await readDirChild(dir)).toEqual([]);
      } finally {
        await dir.close();
        await rm(base, { recursive: true, force: true });
      }
    });

    it('refuses a name that would leave the directory', async () => {
      const base = await mkdtemp(join(tmpdir(), 'opm-nt-'));
      const dir = await openStableDirectory(base);
      try {
        await expect(
          openChild(dir, '..', constants.O_RDONLY),
        ).rejects.toBeInstanceOf(StableHandleError);
      } finally {
        await dir.close();
        await rm(base, { recursive: true, force: true });
      }
    });
  },
);
