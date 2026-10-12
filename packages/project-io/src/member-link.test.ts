/**
 * Member links by project-relative path: placing, reading and removing them.
 * The walkers that meet them are in `member-link.tree.test.ts`.
 *
 * `member-link.libc-at.test.ts` runs both files again with every POSIX child
 * operation routed through libc bound to glibc; the macOS and Windows CI legs
 * run them against libSystem and NT.
 */

import {
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  placeMemberLink,
  readMemberLink,
  removeEmptyScope,
  removeMemberLink,
} from './member-link.js';
import {
  MEMBER,
  cleanup,
  failure,
  project,
  remember,
} from './member-link-support.js';

afterEach(cleanup);

describe('placeMemberLink', () => {
  it('makes the directories a link needs, then the link, and does it again for nothing', async () => {
    const p = await project();
    await rm(p.modules, { recursive: true });

    expect(
      await placeMemberLink(
        p.root,
        'node_modules/@scope/pkg',
        '../../packages/pkg',
      ),
    ).toBe('created');
    expect(
      await placeMemberLink(
        p.root,
        'node_modules/@scope/pkg',
        '../../packages/pkg',
      ),
    ).toBe('unchanged');

    expect(await readMemberLink(p.root, 'node_modules/@scope/pkg')).toEqual({
      kind: 'link',
      target: '../../packages/pkg',
    });
    expect(
      await readFile(join(p.modules, '@scope', 'pkg', 'index.js'), 'utf8'),
    ).toBe('member');
  });

  it('makes a link inside a package that has its own node_modules', async () => {
    const p = await project();
    await mkdir(join(p.modules, 'registry', 'node_modules'));

    expect(
      await placeMemberLink(
        p.root,
        'node_modules/registry/node_modules/pkg',
        '../../../packages/pkg',
      ),
    ).toBe('created');
    expect(
      await readFile(
        join(p.modules, 'registry', 'node_modules', 'pkg', 'index.js'),
        'utf8',
      ),
    ).toBe('member');
  });

  it('reaches the project through a path that has a symlinked ancestor', async () => {
    const p = await project();
    const alias = join(p.root, '..', `alias-${process.pid}-${Date.now()}`);
    await symlink(p.root, alias, 'junction');
    remember(alias);

    expect(await placeMemberLink(alias, 'node_modules/pkg', MEMBER)).toBe(
      'created',
    );

    expect(await readlink(join(p.modules, 'pkg'))).toMatch(/packages[\\/]pkg/u);
  });

  it.each([
    'node_modules/.bin/x',
    'node_modules/registry/lib/x',
    'src/x',
    '../x',
    'x',
    '',
  ])('refuses %j as the place of a link', async (path) => {
    const p = await project();
    expect(
      await failure(() => placeMemberLink(p.root, path, MEMBER)),
    ).toMatchObject({ code: 'UNSAFE_PATH' });
  });

  it('refuses to go through a node_modules that is a link, and makes nothing in the directory it points at', async () => {
    const p = await project();
    const elsewhere = join(p.root, 'elsewhere');
    await mkdir(elsewhere);
    await rm(p.modules, { recursive: true });
    await symlink(elsewhere, p.modules, 'junction');

    expect(
      await failure(() => placeMemberLink(p.root, 'node_modules/pkg', MEMBER)),
    ).toMatchObject({ code: 'UNSAFE_PATH' });

    expect(await readdir(elsewhere)).toEqual([]);
  });

  it('refuses to go through a scope directory that is a link', async () => {
    const p = await project();
    const elsewhere = join(p.root, 'elsewhere');
    await mkdir(elsewhere);
    await symlink(elsewhere, join(p.modules, '@scope'), 'junction');

    expect(
      await failure(() =>
        placeMemberLink(
          p.root,
          'node_modules/@scope/pkg',
          '../../packages/pkg',
        ),
      ),
    ).toMatchObject({ code: 'UNSAFE_PATH' });

    expect(await readdir(elsewhere)).toEqual([]);
  });

  it('refuses a target that leaves the project, and a name that is already a directory', async () => {
    const p = await project();
    expect(
      await failure(() =>
        placeMemberLink(p.root, 'node_modules/pkg', '../../x'),
      ),
    ).toMatchObject({ code: 'UNSAFE_PATH' });
    expect(
      await failure(() =>
        placeMemberLink(p.root, 'node_modules/registry', MEMBER),
      ),
    ).toMatchObject({ code: 'LINK_CONFLICT' });
    expect(
      await readFile(join(p.modules, 'registry', 'package.json'), 'utf8'),
    ).toBe('{}');
  });
});

describe('readMemberLink', () => {
  it('says what a path holds without following it', async () => {
    const p = await project();
    await writeFile(join(p.modules, 'file'), 'x');
    await placeMemberLink(p.root, 'node_modules/pkg', MEMBER);

    expect(await readMemberLink(p.root, 'node_modules/pkg')).toEqual({
      kind: 'link',
      target: MEMBER,
    });
    expect(await readMemberLink(p.root, 'node_modules/registry')).toEqual({
      kind: 'directory',
    });
    expect(await readMemberLink(p.root, 'node_modules/file')).toEqual({
      kind: 'file',
    });
    expect(await readMemberLink(p.root, 'node_modules/missing')).toEqual({
      kind: 'absent',
    });
  });

  it('says absent when a directory on the way is missing, and makes nothing', async () => {
    const p = await project();
    await rm(p.modules, { recursive: true });

    expect(await readMemberLink(p.root, 'node_modules/@scope/pkg')).toEqual({
      kind: 'absent',
    });
    await expect(lstat(p.modules)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('removeMemberLink', () => {
  it('removes a link with the recorded text and never touches what it points at', async () => {
    const p = await project();
    await placeMemberLink(p.root, 'node_modules/pkg', MEMBER);

    expect(await removeMemberLink(p.root, 'node_modules/pkg', MEMBER)).toBe(
      'removed',
    );

    await expect(lstat(join(p.modules, 'pkg'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await readFile(join(p.member, 'sentinel'), 'utf8')).toBe('keep');
    expect(await removeMemberLink(p.root, 'node_modules/pkg', MEMBER)).toBe(
      'absent',
    );
  });

  it('keeps a link that was repointed since, a file and a directory', async () => {
    const p = await project();
    await placeMemberLink(p.root, 'node_modules/pkg', '../packages/other');
    await writeFile(join(p.modules, 'file'), 'precious');

    expect(await removeMemberLink(p.root, 'node_modules/pkg', MEMBER)).toBe(
      'kept',
    );
    expect(await removeMemberLink(p.root, 'node_modules/file', MEMBER)).toBe(
      'kept',
    );
    expect(
      await removeMemberLink(p.root, 'node_modules/registry', MEMBER),
    ).toBe('kept');

    expect(await readMemberLink(p.root, 'node_modules/pkg')).toEqual({
      kind: 'link',
      target: '../packages/other',
    });
    expect(await readFile(join(p.modules, 'file'), 'utf8')).toBe('precious');
    expect(
      await readFile(join(p.modules, 'registry', 'package.json'), 'utf8'),
    ).toBe('{}');
  });
});

describe('removeEmptyScope', () => {
  it('removes an emptied scope and keeps one that still holds something', async () => {
    const p = await project();
    await placeMemberLink(
      p.root,
      'node_modules/@gone/pkg',
      '../../packages/pkg',
    );
    await placeMemberLink(
      p.root,
      'node_modules/@stays/pkg',
      '../../packages/pkg',
    );
    await placeMemberLink(
      p.root,
      'node_modules/@stays/other',
      '../../packages/pkg',
    );

    await removeMemberLink(
      p.root,
      'node_modules/@gone/pkg',
      '../../packages/pkg',
    );
    await removeMemberLink(
      p.root,
      'node_modules/@stays/pkg',
      '../../packages/pkg',
    );

    expect(await removeEmptyScope(p.root, 'node_modules/@gone')).toBe(true);
    expect(await removeEmptyScope(p.root, 'node_modules/@stays')).toBe(false);
    expect((await readdir(p.modules)).sort()).toEqual(['@stays', 'registry']);
    expect(await removeEmptyScope(p.root, 'node_modules/@gone')).toBe(false);
  });

  it.each(['node_modules/registry', 'node_modules', 'src/@x', '@x'])(
    'refuses %j, which is not a scope directory of a node_modules',
    async (path) => {
      const p = await project();
      expect(await failure(() => removeEmptyScope(p.root, path))).toMatchObject(
        {
          code: 'UNSAFE_PATH',
        },
      );
    },
  );
});
