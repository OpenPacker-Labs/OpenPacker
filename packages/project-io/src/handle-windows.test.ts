import { constants } from 'node:fs';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  O_DIRECTORY,
  StableHandleError,
  lstatChild,
  mkdirChild,
  openChild,
  readDirChild,
  readDirChildBounded,
  removeChild,
  renameChild,
} from './handle-path.js';

/**
 * Windows has no procfs, so every child operation is an NtCreateFile with the
 * parent handle as RootDirectory, reached through koffi. Linux and macOS never
 * load that path, so this runs only where it is the real thing; the CI build
 * matrix runs it on its Windows legs.
 *
 * Each step writes a line to stderr before it runs. A native fault takes the
 * process down without a JavaScript error, and the last line then names the
 * call that did it.
 */
const trace = (message: string): void => {
  writeSync(2, `[handle-windows] ${message}\n`);
};

describe.skipIf(process.platform !== 'win32')(
  'handle-relative I/O through NT handles',
  () => {
    let base = '';
    let dir: Awaited<ReturnType<typeof open>>;

    beforeAll(async () => {
      trace('make a temporary directory');
      base = await mkdtemp(join(tmpdir(), 'opm-nt-'));
      trace(`open it as a handle: ${base}`);
      dir = await open(base, constants.O_RDONLY);
    });

    afterAll(async () => {
      trace('clean up');
      await dir?.close();
      await rm(base, { recursive: true, force: true });
    });

    it('opens an existing child directory of an open directory', async () => {
      const parent = await open(dirname(base), constants.O_RDONLY);
      try {
        trace(`openChild(${basename(base)}) is the first NT call`);
        const child = await openChild(
          parent,
          basename(base),
          constants.O_RDONLY | O_DIRECTORY,
        );
        trace('openChild returned a handle');
        await child.close();
      } finally {
        await parent.close();
      }
    });

    it('creates a directory and a file under an open directory', async () => {
      trace('mkdirChild sub');
      await mkdirChild(dir, 'sub');
      trace('openChild a.txt (create, exclusive)');
      const file = await openChild(
        dir,
        'a.txt',
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o644,
      );
      trace('writeFile');
      await file.writeFile('hello');
      trace('close');
      await file.close();
    });

    it('lists and stats what it made', async () => {
      trace('readDirChild');
      expect((await readDirChild(dir)).sort()).toEqual(['a.txt', 'sub']);
      trace('lstatChild');
      expect(Number((await lstatChild(dir, 'a.txt')).size)).toBe(5);
    });

    it('renames and removes children', async () => {
      trace('renameChild');
      await renameChild(dir, 'a.txt', 'b.txt');
      expect((await readDirChild(dir)).sort()).toEqual(['b.txt', 'sub']);
      trace('removeChild file');
      await removeChild(dir, 'b.txt', {});
      trace('removeChild directory');
      await removeChild(dir, 'sub', { recursive: true });
      expect(await readDirChild(dir)).toEqual([]);
    });

    it('stops a listing at the bound', async () => {
      const names = ['one', 'two', 'three'];
      for (const name of names) {
        trace(`openChild ${name} (create, exclusive)`);
        const file = await openChild(
          dir,
          name,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
          0o644,
        );
        await file.close();
      }
      trace('readDirChildBounded 2 of 3');
      const cut = await readDirChildBounded(dir, 2);
      expect([cut.exceeded, cut.entries.length]).toEqual([true, 2]);
      trace('readDirChildBounded 3 of 3');
      const whole = await readDirChildBounded(dir, 3);
      expect([whole.exceeded, whole.entries.length]).toEqual([false, 3]);
      expect(whole.entries.every((entry) => entry.isFile())).toBe(true);
      for (const name of names) await removeChild(dir, name, {});
      expect(await readDirChild(dir)).toEqual([]);
    });

    it('refuses a file where a directory was asked for', async () => {
      trace('create a plain file, then open it as a directory');
      const plain = await openChild(
        dir,
        'plain',
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o644,
      );
      await plain.close();
      await expect(
        openChild(dir, 'plain', constants.O_RDONLY | O_DIRECTORY),
      ).rejects.toMatchObject({ code: 'ENOTDIR' });
      await removeChild(dir, 'plain', {});
    });

    it('refuses a name that would leave the directory', async () => {
      trace('openChild ..');
      await expect(
        openChild(dir, '..', constants.O_RDONLY),
      ).rejects.toBeInstanceOf(StableHandleError);
    });
  },
);
