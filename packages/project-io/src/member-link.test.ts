/**
 * Member links by project-relative path, and the walkers that meet them.
 *
 * `member-link.libc-at.test.ts` runs this file again with every POSIX child
 * operation routed through libc bound to glibc; the macOS and Windows CI legs
 * run it against libSystem and NT.
 */

import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  collectFiles,
  collectFilesFromHandle,
  collectTree,
  materialiseTree,
  removeTree,
  type RecordedLinks,
} from './layout.js';
import {
  placeMemberLink,
  readMemberLink,
  removeEmptyScope,
  removeMemberLink,
} from './member-link.js';
import { O_DIRECTORY } from './handle-path.js';

const MEMBER = '../packages/pkg';

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/** A project with a member, a registry package, and nothing linked yet. */
async function project() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'member-walk-')));
  temps.push(root);
  const member = join(root, 'packages', 'pkg');
  await mkdir(member, { recursive: true });
  await writeFile(join(member, 'index.js'), 'member');
  await writeFile(join(member, 'sentinel'), 'keep');
  const modules = join(root, 'node_modules');
  await mkdir(join(modules, 'registry'), { recursive: true });
  await writeFile(join(modules, 'registry', 'package.json'), '{}');
  const record = (links: Record<string, string>): RecordedLinks => ({
    projectRoot: root,
    base: 'node_modules',
    links: new Map(Object.entries(links)),
  });
  return { root, member, modules, record };
}

async function failure<T>(
  work: () => Promise<T>,
): Promise<(Error & { code?: string; path?: string }) | undefined> {
  try {
    await work();
    return undefined;
  } catch (error) {
    // SAFETY: the operations under test throw Error values with an optional code.
    return error as Error & { code?: string; path?: string };
  }
}

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
    temps.push(alias);

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
