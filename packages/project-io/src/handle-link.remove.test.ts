/**
 * What the two removals refuse, and that they refuse it themselves.
 *
 * `unlinkChild` takes a link away and nothing else, and when it is told what the
 * link must still say it removes it only if it does; `rmdirChild` takes an
 * empty directory away and nothing else. Neither is "look, then remove": the
 * system (or on Windows the handle that was read) does the refusing at the
 * moment it acts.
 *
 * `handle-link.libc-at.test.ts` runs this file again through libc bound to
 * glibc; the macOS and Windows legs run it against libSystem and NT.
 */

import {
  lstat,
  mkdir,
  readFile,
  readdir,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readlinkChild, symlinkChild, unlinkChild } from './handle-link.js';
import { rmdirChild, unlinkNonDirectory } from './handle-remove.js';
import { MEMBER, cleanup, failure, project } from './handle-link-support.js';

afterEach(cleanup);

const onWindows = process.platform === 'win32';

describe('unlinkChild told what the link must say', () => {
  it('removes a link whose text is the expected one, and never what it points at', async () => {
    const p = await project();
    await writeFile(join(p.member, 'sentinel'), 'keep');
    await symlinkChild(p.modules, 'pkg', MEMBER, p.site);

    await unlinkChild(p.modules, 'pkg', { target: MEMBER, site: p.site });

    await expect(lstat(p.link('pkg'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await readFile(join(p.member, 'sentinel'), 'utf8')).toBe('keep');
  });

  it('leaves a link whose text is another, and names both', async () => {
    const p = await project();
    await symlinkChild(p.modules, 'pkg', '../packages/other', p.site);

    const refusal = await failure(() =>
      unlinkChild(p.modules, 'pkg', { target: MEMBER, site: p.site }),
    );

    expect(
      refusal,
      'unlinkChild(node_modules, pkg) expecting ../packages/pkg over a link to ../packages/other',
    ).toMatchObject({ code: 'LINK_CONFLICT', path: 'node_modules/pkg' });
    expect(refusal?.message).toBe(
      'node_modules/pkg is a link to "../packages/other", not the "../packages/pkg" it was expected to be; it is not removed',
    );
    expect(await readlinkChild(p.modules, 'pkg', p.site)).toBe(
      '../packages/other',
    );
  });

  it('leaves a file and a directory, and nothing is expected of nothing', async () => {
    const p = await project();
    await writeFile(p.link('file'), 'precious');
    await mkdir(p.link('folder'));
    const expected = { target: MEMBER, site: p.site };

    expect(
      await failure(() => unlinkChild(p.modules, 'file', expected)),
    ).toMatchObject({ code: 'NOT_A_LINK' });
    expect(
      await failure(() => unlinkChild(p.modules, 'folder', expected)),
    ).toMatchObject({ code: 'NOT_A_LINK' });
    expect(
      await failure(() => unlinkChild(p.modules, 'missing', expected)),
    ).toMatchObject({ code: 'ENOENT' });

    expect(await readFile(p.link('file'), 'utf8')).toBe('precious');
    expect((await lstat(p.link('folder'))).isDirectory()).toBe(true);
  });
});

describe('rmdirChild', () => {
  it('removes an empty directory', async () => {
    const p = await project();
    await mkdir(p.link('empty'));

    await rmdirChild(p.modules, 'empty');

    await expect(lstat(p.link('empty'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('refuses a directory with something in it, and keeps it', async () => {
    const p = await project();
    await mkdir(p.link('full'));
    await writeFile(join(p.link('full'), 'precious'), 'x');

    expect(
      await failure(() => rmdirChild(p.modules, 'full')),
      'rmdirChild(node_modules, full) with a file in it',
    ).toMatchObject({ code: 'ENOTEMPTY' });

    expect(await readdir(p.link('full'))).toEqual(['precious']);
  });

  it('says ENOENT for nothing', async () => {
    const p = await project();

    expect(await failure(() => rmdirChild(p.modules, 'missing'))).toMatchObject(
      {
        code: 'ENOENT',
      },
    );
  });

  it.skipIf(onWindows)(
    'refuses a file, and a link to a directory without following it',
    async () => {
      const p = await project();
      await writeFile(p.link('file'), 'precious');
      await symlink(p.member, p.link('alias'));

      expect(await failure(() => rmdirChild(p.modules, 'file'))).toMatchObject({
        code: 'ENOTDIR',
      });
      expect(await failure(() => rmdirChild(p.modules, 'alias'))).toMatchObject(
        {
          code: 'ENOTDIR',
        },
      );

      expect(await readFile(p.link('file'), 'utf8')).toBe('precious');
      expect((await lstat(p.link('alias'))).isSymbolicLink()).toBe(true);
      expect(await readdir(p.member)).toEqual(['index.js']);
    },
  );
});

describe.skipIf(onWindows)('unlinkNonDirectory', () => {
  it('removes a file and a link, and refuses a directory whatever it holds', async () => {
    const p = await project();
    await writeFile(p.link('file'), 'x');
    await symlink(p.member, p.link('alias'));
    await mkdir(p.link('folder'));
    await writeFile(join(p.link('folder'), 'precious'), 'x');

    await unlinkNonDirectory(p.modules, 'file');
    await unlinkNonDirectory(p.modules, 'alias');
    const refusal = await failure(() =>
      unlinkNonDirectory(p.modules, 'folder'),
    );

    expect(
      refusal?.code,
      'code of unlinkNonDirectory(node_modules, folder) on a directory: EISDIR on Linux, EPERM on macOS',
    ).toMatch(/^(EISDIR|EPERM)$/u);
    expect((await readdir(join(p.root, 'node_modules'))).sort()).toEqual([
      '@scope',
      'folder',
    ]);
    expect(await readdir(p.link('folder'))).toEqual(['precious']);
    expect(await readdir(p.member)).toEqual(['index.js']);
  });
});
