/**
 * `readlinkChild` and `unlinkChild`; see `handle-link.test.ts` for how these
 * suites are run on each platform.
 */

import { lstat, mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readlinkChild, symlinkChild, unlinkChild } from './handle-link.js';
import {
  DIRECTORY,
  MEMBER,
  cleanup,
  failure,
  handles,
  project,
} from './handle-link-support.js';
import { removeChild } from './handle-path.js';

afterEach(cleanup);

describe('readlinkChild', () => {
  it('reads the text of a link without following it', async () => {
    const p = await project();
    await symlinkChild(p.modules, 'pkg', MEMBER, p.site);
    await symlinkChild(p.modules, 'ghost', '../packages/missing', p.site);

    expect(await readlinkChild(p.modules, 'pkg', p.site)).toBe(MEMBER);
    expect(await readlinkChild(p.modules, 'ghost', p.site)).toBe(
      '../packages/missing',
    );
  });

  it('says EINVAL for a file or a directory and ENOENT for nothing', async () => {
    const p = await project();
    await writeFile(p.link('file'), 'x');
    await mkdir(p.link('folder'));

    expect(
      await failure(() => readlinkChild(p.modules, 'file', p.site)),
    ).toMatchObject({ code: 'EINVAL' });
    expect(
      await failure(() => readlinkChild(p.modules, 'folder', p.site)),
    ).toMatchObject({ code: 'EINVAL' });
    expect(
      await failure(() => readlinkChild(p.modules, 'missing', p.site)),
    ).toMatchObject({ code: 'ENOENT' });
  });

  it.each(['', '.', '..', 'a/b', 'a\\b', 'a\0b'])(
    'refuses the name %j before asking the system',
    async (name) => {
      const p = await project();
      expect(
        await failure(() => readlinkChild(p.modules, name, p.site)),
      ).toMatchObject({ code: 'UNSAFE_PATH' });
    },
  );
});

describe('unlinkChild', () => {
  it('removes the link and never follows it', async () => {
    const p = await project();
    await writeFile(join(p.member, 'sentinel'), 'keep');
    await symlinkChild(p.modules, 'pkg', MEMBER, p.site);

    await unlinkChild(p.modules, 'pkg');

    await expect(lstat(p.link('pkg'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await readFile(join(p.member, 'sentinel'), 'utf8')).toBe('keep');
    expect(await readFile(join(p.member, 'index.js'), 'utf8')).toBe('member');
  });

  it('removes a dangling link', async () => {
    const p = await project();
    await symlinkChild(p.modules, 'ghost', '../packages/missing', p.site);

    await unlinkChild(p.modules, 'ghost');

    await expect(lstat(p.link('ghost'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('refuses a regular file, a directory and nothing, and leaves them', async () => {
    const p = await project();
    await writeFile(p.link('file'), 'precious');
    await mkdir(p.link('folder'));
    await writeFile(join(p.link('folder'), 'inner'), 'precious');

    expect(await failure(() => unlinkChild(p.modules, 'file'))).toMatchObject({
      code: 'NOT_A_LINK',
    });
    expect(await failure(() => unlinkChild(p.modules, 'folder'))).toMatchObject(
      { code: 'NOT_A_LINK' },
    );
    expect(
      await failure(() => unlinkChild(p.modules, 'missing')),
    ).toMatchObject({ code: 'ENOENT' });

    expect(await readFile(p.link('file'), 'utf8')).toBe('precious');
    expect(await readFile(join(p.link('folder'), 'inner'), 'utf8')).toBe(
      'precious',
    );
  });

  it('is not what removes a tree: removeChild recursive unlinks a link inside one without following it', async () => {
    const p = await project();
    await writeFile(join(p.member, 'sentinel'), 'keep');
    await mkdir(join(p.root, 'node_modules', 'host', 'node_modules'), {
      recursive: true,
    });
    const inner = await open(
      join(p.root, 'node_modules', 'host', 'node_modules'),
      DIRECTORY,
    );
    handles.push(inner);
    await symlinkChild(inner, 'inner', '../../../packages/pkg', {
      directory: 'node_modules/host/node_modules',
      projectRoot: p.root,
    });

    await removeChild(p.modules, 'host', { recursive: true });

    await expect(lstat(p.link('host'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await readFile(join(p.member, 'sentinel'), 'utf8')).toBe('keep');
  });
});
