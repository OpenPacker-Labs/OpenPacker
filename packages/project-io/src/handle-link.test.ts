/**
 * Workspace-member links through the handle API, on whichever backend this
 * platform uses. `handle-link.libc-at.test.ts` runs the same file again with
 * every POSIX child operation routed through libc bound to glibc, and the
 * macOS and Windows legs of CI run it against libSystem and the NT API.
 */

import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  readlinkChild,
  symlinkChild,
  unlinkChild,
  type LinkSite,
} from './handle-link.js';
import { O_DIRECTORY, removeChild } from './handle-path.js';

const DIRECTORY = constants.O_RDONLY | O_DIRECTORY | constants.O_NOFOLLOW;
const MEMBER = '../packages/pkg';

const temps: string[] = [];
const handles: FileHandle[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()));
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function project() {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'member-link-'));
  temps.push(root);
  await mkdir(join(root, 'node_modules', '@scope'), { recursive: true });
  await mkdir(join(root, 'packages', 'pkg'), { recursive: true });
  await writeFile(join(root, 'packages', 'pkg', 'index.js'), 'member');
  const modules = await open(join(root, 'node_modules'), DIRECTORY);
  const scope = await open(join(root, 'node_modules', '@scope'), DIRECTORY);
  handles.push(modules, scope);
  const site: LinkSite = { directory: 'node_modules', projectRoot: root };
  const scopeSite: LinkSite = {
    directory: 'node_modules/@scope',
    projectRoot: root,
  };
  return {
    root,
    modules,
    scope,
    site,
    scopeSite,
    link: (name: string) => join(root, 'node_modules', name),
    member: join(root, 'packages', 'pkg'),
  };
}

/** The error an operation fails with, or undefined. */
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

describe('symlinkChild', () => {
  it('makes a link whose text is the target, and Node resolves through it', async () => {
    const p = await project();

    expect(await symlinkChild(p.modules, 'pkg', MEMBER, p.site)).toBe(
      'created',
    );

    expect((await lstat(p.link('pkg'))).isSymbolicLink()).toBe(true);
    expect(await readlinkChild(p.modules, 'pkg', p.site)).toBe(MEMBER);
    expect(await realpath(p.link('pkg'))).toBe(await realpath(p.member));
    expect(await readFile(join(p.link('pkg'), 'index.js'), 'utf8')).toBe(
      'member',
    );
  });

  it('is idempotent: the same link again changes nothing', async () => {
    const p = await project();
    await symlinkChild(p.modules, 'pkg', MEMBER, p.site);
    const before = await lstat(p.link('pkg'), { bigint: true });

    expect(await symlinkChild(p.modules, 'pkg', MEMBER, p.site)).toBe(
      'unchanged',
    );

    const after = await lstat(p.link('pkg'), { bigint: true });
    expect([after.dev, after.ino]).toEqual([before.dev, before.ino]);
    expect(after.mtimeNs).toBe(before.mtimeNs);
  });

  it('refuses to replace a link that points somewhere else, and names both', async () => {
    const p = await project();
    await symlinkChild(p.modules, 'pkg', MEMBER, p.site);

    const refusal = await failure(() =>
      symlinkChild(p.modules, 'pkg', '../packages/other', p.site),
    );

    expect(refusal).toMatchObject({
      code: 'LINK_CONFLICT',
      path: 'node_modules/pkg',
    });
    expect(refusal?.message).toBe(
      'node_modules/pkg is a link to "../packages/pkg", not "../packages/other"; it is not replaced',
    );
    expect(await readlinkChild(p.modules, 'pkg', p.site)).toBe(MEMBER);
  });

  it('refuses a name that already holds a regular file, and leaves it', async () => {
    const p = await project();
    await writeFile(p.link('pkg'), 'precious');

    const refusal = await failure(() =>
      symlinkChild(p.modules, 'pkg', MEMBER, p.site),
    );

    expect(refusal).toMatchObject({ code: 'LINK_CONFLICT' });
    expect(refusal?.message).toBe(
      'node_modules/pkg is a regular file, not a link; it is not replaced',
    );
    expect(await readFile(p.link('pkg'), 'utf8')).toBe('precious');
  });

  it('refuses a name that already holds a directory, and leaves its contents', async () => {
    const p = await project();
    await mkdir(p.link('pkg'));
    await writeFile(join(p.link('pkg'), 'inner'), 'precious');

    const refusal = await failure(() =>
      symlinkChild(p.modules, 'pkg', MEMBER, p.site),
    );

    expect(refusal).toMatchObject({ code: 'LINK_CONFLICT' });
    expect(refusal?.message).toBe(
      'node_modules/pkg is a directory, not a link; it is not replaced',
    );
    expect(await readFile(join(p.link('pkg'), 'inner'), 'utf8')).toBe(
      'precious',
    );
  });

  it.each([
    ['an absolute target', '/etc'],
    ['the filesystem root', '/'],
    ['a drive path', 'C:/x'],
    ['an empty target', ''],
    ['a target that leaves the root', '../../x'],
    ['the root itself', '..'],
    ['a target that leaves the root and comes back in', '../../packages/pkg'],
    ['a NUL', '../packages/pkg\0'],
    ['a backslash', '..\\packages\\pkg'],
    ['a target that is not normalised', '../packages/../packages/pkg'],
    ['a registry package', '../node_modules/other'],
    ['opm state', '../.opm/store/x'],
  ])('refuses %s and creates nothing', async (_label, target) => {
    const p = await project();

    const refusal = await failure(() =>
      symlinkChild(p.modules, 'pkg', target, p.site),
    );

    expect(refusal).toMatchObject({ code: 'UNSAFE_PATH' });
    expect(refusal?.message).toMatch(
      /^Refusing to create a link at node_modules\/pkg: /u,
    );
    await expect(lstat(p.link('pkg'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it.each([
    '.bin',
    '.hidden',
    'node_modules',
    '@scope',
    'a/b',
    '..',
    '',
    'a b',
  ])('refuses the name %j', async (name) => {
    const p = await project();

    const refusal = await failure(() =>
      symlinkChild(p.modules, name, MEMBER, p.site),
    );

    expect(refusal).toMatchObject({ code: 'UNSAFE_PATH' });
  });

  it.each(['node_modules/.bin', 'node_modules/pkg', 'packages', '', '.'])(
    'refuses to put a link in %j',
    async (directory) => {
      const p = await project();

      const refusal = await failure(() =>
        symlinkChild(p.modules, 'x', MEMBER, { ...p.site, directory }),
      );

      expect(refusal).toMatchObject({ code: 'UNSAFE_PATH' });
    },
  );

  it('makes a scoped link inside the scope directory', async () => {
    const p = await project();

    expect(
      await symlinkChild(p.scope, 'pkg', '../../packages/pkg', p.scopeSite),
    ).toBe('created');

    expect(await readlinkChild(p.scope, 'pkg', p.scopeSite)).toBe(
      '../../packages/pkg',
    );
    expect(
      await readFile(
        join(p.root, 'node_modules', '@scope', 'pkg', 'index.js'),
        'utf8',
      ),
    ).toBe('member');
  });

  it('refuses a scope as a link name', async () => {
    const p = await project();
    const refusal = await failure(() =>
      symlinkChild(p.modules, '@scope', '../packages/pkg', p.site),
    );
    expect(refusal).toMatchObject({ code: 'UNSAFE_PATH' });
  });

  it('makes a link to a target that does not exist yet', async () => {
    const p = await project();

    expect(
      await symlinkChild(p.modules, 'ghost', '../packages/missing', p.site),
    ).toBe('created');

    expect((await lstat(p.link('ghost'))).isSymbolicLink()).toBe(true);
    await expect(stat(p.link('ghost'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    // Once the member appears, the link resolves with no change to it.
    await mkdir(join(p.root, 'packages', 'missing'));
    await writeFile(join(p.root, 'packages', 'missing', 'x'), 'late');
    expect(await readFile(join(p.link('ghost'), 'x'), 'utf8')).toBe('late');
  });

  it('keeps a link whose member directory is later replaced by a regular file', async () => {
    const p = await project();
    await symlinkChild(p.modules, 'pkg', MEMBER, p.site);
    await rename(p.member, join(p.root, 'packages', 'moved'));
    await writeFile(p.member, 'now a file');

    expect(await symlinkChild(p.modules, 'pkg', MEMBER, p.site)).toBe(
      'unchanged',
    );
    expect(await readlinkChild(p.modules, 'pkg', p.site)).toBe(MEMBER);
    // A junction names directories only, so on Windows the file is not
    // readable through it; the link itself is what this test is about.
    if (process.platform !== 'win32')
      expect(await readFile(p.link('pkg'), 'utf8')).toBe('now a file');

    await unlinkChild(p.modules, 'pkg');
    expect(await readFile(p.member, 'utf8')).toBe('now a file');
    await expect(lstat(p.link('pkg'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('carries a target with non-ASCII characters', async () => {
    const p = await project();
    await mkdir(join(p.root, 'packages', 'é-日本'));

    await symlinkChild(p.modules, 'pkg', '../packages/é-日本', p.site);

    expect(await readlinkChild(p.modules, 'pkg', p.site)).toBe(
      '../packages/é-日本',
    );
    expect(
      await symlinkChild(p.modules, 'pkg', '../packages/é-日本', p.site),
    ).toBe('unchanged');
  });

  // Windows is not asked to rename a directory it holds open handles on; the
  // guarantee there is NtCreateFile's RootDirectory, which the NT suite shows.
  it.skipIf(process.platform === 'win32')(
    'makes the link in the directory the handle names, whatever the pathname is now',
    async () => {
      const p = await project();
      const moved = join(p.root, 'moved-modules');
      const outside = join(p.root, 'outside');
      await mkdir(outside);
      await rename(join(p.root, 'node_modules'), moved);
      await symlink(outside, join(p.root, 'node_modules'), 'junction');

      await symlinkChild(p.modules, 'pkg', MEMBER, p.site);

      expect((await lstat(join(moved, 'pkg'))).isSymbolicLink()).toBe(true);
      await expect(lstat(join(outside, 'pkg'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    },
  );

  it('lets twenty callers create the same link at once: one makes it, the rest find it', async () => {
    const p = await project();

    const outcomes = await Promise.all(
      Array.from({ length: 20 }, () =>
        symlinkChild(p.modules, 'pkg', MEMBER, p.site),
      ),
    );

    expect(outcomes.filter((outcome) => outcome === 'created')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === 'unchanged')).toHaveLength(
      19,
    );
    expect(await readlinkChild(p.modules, 'pkg', p.site)).toBe(MEMBER);
  });

  it('lets exactly one of two disagreeing callers win; the other is told', async () => {
    const p = await project();
    const targets = [MEMBER, '../packages/other'];

    const outcomes = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        symlinkChild(p.modules, 'pkg', targets[index % 2]!, p.site).then(
          (outcome) => outcome,
          (error: NodeJS.ErrnoException) => error.code,
        ),
      ),
    );

    expect(outcomes.filter((outcome) => outcome === 'created')).toHaveLength(1);
    expect(
      outcomes.every((outcome) =>
        ['created', 'unchanged', 'LINK_CONFLICT'].includes(outcome!),
      ),
    ).toBe(true);
    expect(targets).toContain(await readlinkChild(p.modules, 'pkg', p.site));
  });
});

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
