/**
 * Walking a `node_modules` that holds member links, and writing and removing
 * around them. See `member-link.test.ts` for how these suites are run.
 */

import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  stat,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { O_DIRECTORY } from './handle-path.js';
import {
  collectFiles,
  collectFilesFromHandle,
  collectTree,
} from './layout-collect.js';
import { materialiseTree, removeTree } from './layout.js';
import { placeMemberLink } from './member-link.js';
import { MEMBER, cleanup, failure, project } from './member-link-support.js';

afterEach(cleanup);

describe('walking a node_modules that holds member links', () => {
  it('refuses a link the record does not name, exactly as before', async () => {
    const p = await project();
    await placeMemberLink(p.root, 'node_modules/pkg', MEMBER);

    const unrecorded = await failure(() => collectFiles(p.modules));
    const withEmptyRecord = await failure(() =>
      collectTree(p.modules, '', { memberLinks: p.record({}) }),
    );
    const handle = await open(p.modules, constants.O_RDONLY | O_DIRECTORY);
    const throughHandle = await failure(() => collectFilesFromHandle(handle));
    await handle.close();

    for (const refusal of [unrecorded, withEmptyRecord, throughHandle])
      expect(refusal).toMatchObject({ code: 'UNSAFE_PATH', path: 'pkg' });
  });

  it('refuses a recorded path whose link now says something else', async () => {
    const p = await project();
    await placeMemberLink(p.root, 'node_modules/pkg', '../packages/other');

    expect(
      await failure(() =>
        collectTree(p.modules, '', { memberLinks: p.record({ pkg: MEMBER }) }),
      ),
    ).toMatchObject({ code: 'UNSAFE_PATH', path: 'pkg' });
  });

  it('refuses a link at a path the record names for another path', async () => {
    const p = await project();
    await placeMemberLink(p.root, 'node_modules/pkg', MEMBER);

    expect(
      await failure(() =>
        collectTree(p.modules, '', {
          memberLinks: p.record({ other: MEMBER }),
        }),
      ),
    ).toMatchObject({ code: 'UNSAFE_PATH' });
  });

  it('reads a recorded link as a leaf: its path and text, and the other files as usual', async () => {
    const p = await project();
    await placeMemberLink(p.root, 'node_modules/pkg', MEMBER);
    await placeMemberLink(
      p.root,
      'node_modules/@scope/pkg',
      '../../packages/pkg',
    );

    const tree = await collectTree(p.modules, 'node_modules', {
      memberLinks: p.record({
        pkg: MEMBER,
        '@scope/pkg': '../../packages/pkg',
      }),
    });

    expect(tree.files.map((file) => file.path)).toEqual([
      'node_modules/registry/package.json',
    ]);
    expect(tree.links).toEqual([
      { path: 'node_modules/@scope/pkg', target: '../../packages/pkg' },
      { path: 'node_modules/pkg', target: MEMBER },
    ]);
  });

  it('never opens, lists or reads what a link points at, even when it points at the filesystem root', async () => {
    const p = await project();
    // Not something this package can create (the rules refuse it); a stale or
    // hostile entry that a record nevertheless names.
    await symlink(
      process.platform === 'win32' ? 'C:\\' : '/',
      join(p.modules, 'root'),
      'junction',
    );
    await symlink(p.member, join(p.modules, 'abs'), 'junction');

    const tree = await collectTree(p.modules, '', {
      memberLinks: p.record({
        root: process.platform === 'win32' ? 'C:\\' : '/',
        abs: p.member,
      }),
    }).catch((error: Error) => error);

    // On POSIX the recorded text matches and both are leaves. On Windows a
    // junction's text is rewritten relative, so the record is refused: either
    // way nothing was entered, which a walk of `/` could not have survived.
    if (tree instanceof Error)
      expect(tree).toMatchObject({ code: 'UNSAFE_PATH' });
    else expect(tree.links.map((link) => link.path)).toEqual(['abs', 'root']);
  });

  it.skipIf(process.platform === 'win32')(
    'does not count the size of a target: a link to a file past the read limit is a leaf',
    async () => {
      const p = await project();
      const huge = join(p.root, 'packages', 'huge.bin');
      await writeFile(huge, '');
      // Sparse: 600 MiB the walker would refuse to read (the limit is 512 MiB).
      await truncate(huge, 600 * 1024 * 1024);
      await placeMemberLink(
        p.root,
        'node_modules/huge',
        '../packages/huge.bin',
      );

      const tree = await collectTree(p.modules, '', {
        memberLinks: p.record({ huge: '../packages/huge.bin' }),
      });

      expect(tree.links).toEqual([
        { path: 'huge', target: '../packages/huge.bin' },
      ]);
      expect((await stat(huge)).size).toBe(600 * 1024 * 1024);
      // The same file, as an ordinary file of the walked tree, is refused.
      await writeFile(join(p.modules, 'ordinary.bin'), '');
      await truncate(join(p.modules, 'ordinary.bin'), 600 * 1024 * 1024);
      expect(
        await failure(() =>
          collectTree(p.modules, '', {
            memberLinks: p.record({ huge: '../packages/huge.bin' }),
          }),
        ),
      ).toMatchObject({ code: 'UNSAFE_PATH', path: 'ordinary.bin' });
    },
  );
});

describe('writing and removing around member links', () => {
  it('replaces a member link at a package destination without following it', async () => {
    const p = await project();
    await placeMemberLink(p.root, 'node_modules/pkg', MEMBER);
    const source = join(p.root, 'store', 'pkg');
    await mkdir(source, { recursive: true });
    await writeFile(join(source, 'package.json'), '{"name":"pkg"}');

    await materialiseTree(source, join(p.modules, 'pkg'), p.modules);

    expect((await lstat(join(p.modules, 'pkg'))).isDirectory()).toBe(true);
    expect(await readFile(join(p.modules, 'pkg', 'package.json'), 'utf8')).toBe(
      '{"name":"pkg"}',
    );
    expect(await readFile(join(p.member, 'sentinel'), 'utf8')).toBe('keep');
    expect(await readFile(join(p.member, 'index.js'), 'utf8')).toBe('member');
    await expect(lstat(join(p.member, 'package.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('never writes a registry package through a member link', async () => {
    const p = await project();
    await placeMemberLink(p.root, 'node_modules/pkg', MEMBER);
    const source = join(p.root, 'store', 'dep');
    await mkdir(source, { recursive: true });
    await writeFile(join(source, 'package.json'), '{"name":"dep"}');

    const refusal = await failure(() =>
      materialiseTree(
        source,
        join(p.modules, 'pkg', 'node_modules', 'dep'),
        p.modules,
      ),
    );

    expect(refusal).toMatchObject({ code: 'UNSAFE_PATH' });
    expect(await readdir(p.member)).toEqual(['index.js', 'sentinel']);
  });

  it('refuses a source tree that holds a link, recorded or not', async () => {
    const p = await project();
    const source = join(p.root, 'store', 'pkg');
    await mkdir(source, { recursive: true });
    await writeFile(join(source, 'package.json'), '{}');
    await symlink(p.member, join(source, 'link'), 'junction');

    expect(
      await failure(() =>
        materialiseTree(source, join(p.modules, 'copied'), p.modules, {
          link: true,
        }),
      ),
    ).toMatchObject({ code: 'UNSAFE_PATH' });
    await expect(lstat(join(p.modules, 'copied'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('removes a node_modules holding links without following one', async () => {
    const p = await project();
    await placeMemberLink(p.root, 'node_modules/pkg', MEMBER);
    await placeMemberLink(
      p.root,
      'node_modules/@scope/pkg',
      '../../packages/pkg',
    );

    await removeTree(p.modules);

    await expect(lstat(p.modules)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(p.member, 'sentinel'), 'utf8')).toBe('keep');
    expect(await readFile(join(p.member, 'index.js'), 'utf8')).toBe('member');
  });

  it('removes a link itself when it is the path given', async () => {
    const p = await project();
    await placeMemberLink(p.root, 'node_modules/pkg', MEMBER);

    await removeTree(join(p.modules, 'pkg'));

    await expect(lstat(join(p.modules, 'pkg'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await readFile(join(p.member, 'sentinel'), 'utf8')).toBe('keep');
  });
});
