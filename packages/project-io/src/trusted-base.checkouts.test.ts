/**
 * The checkouts and trees no base is resolved through, wherever a command
 * runs (ADR 0034, trusted bases): every directory around the working
 * directory and around each base the environment names that holds `.git`,
 * the superproject or main work tree a gitfile leads to, the work tree
 * `GIT_WORK_TREE` or `GIT_DIR` names, a home directory that is a checkout or
 * lies in one, and the tree a command runs in when it has no `.git` at all.
 * Each layout made `opmx pkg:…` publish its store and tool cache where the
 * link points before.
 */

import { execFileSync } from 'node:child_process';
import {
  chmod,
  lchown,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { libcDirectoryOps } from './base-resolve-libc.js';
import { useResolverOpsForTesting } from './base-resolve.js';
import { linuxGlibcProfile } from './handle-libc-profile.js';
import { glibcLinux } from './handle-test-support.js';
import { topmostBelow } from './checkout-fences.js';
import {
  BASE_VARIABLES,
  beginCommand,
  fenceWorkingProject,
  forgetBases,
  openRootDirectory,
  openStableDirectory,
  realBase,
  trustBase,
  writeFileAtomic,
} from './index.js';

const POSIX = process.platform === 'linux' || process.platform === 'darwin';
const ROOT = process.geteuid?.() === 0;
const NOBODY = 65534;
const REFUSED = /^(ENOTDIR|ELOOP|UNSAFE_PATH)$/u;

const worlds: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  forgetBases();
  for (const world of worlds.splice(0))
    await rm(world, { recursive: true, force: true });
});

/** A fresh world, its own home, and nothing the environment names but what a test does. */
async function world(): Promise<string> {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'checkouts-'));
  worlds.push(dir);
  for (const name of [
    ...BASE_VARIABLES,
    'OPM_STORE_HOME',
    'OPM_TOOL_CACHE',
    'OPM_AUTH_CONFIG',
    'GIT_DIR',
    'GIT_WORK_TREE',
  ])
    vi.stubEnv(name, '');
  await mkdir(join(dir, 'home'));
  await mkdir(join(dir, 'outside'));
  vi.stubEnv('HOME', join(dir, 'home'));
  return dir;
}

/** `<dir>/.cache -> <outside>`, as a checkout may commit it. */
async function linkedCache(dir: string, outside: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  await symlink(outside, join(dir, '.cache'));
  return join(dir, '.cache');
}

/** What a store, tool cache or config root under `cache` would do: open its root, making it. */
async function storeRoot(cache: string): Promise<void> {
  const opening = await openRootDirectory(join(cache, 'openpacker', 'store'), {
    create: true,
    lastMayBeLink: false,
  });
  await opening.handle.close();
}

/** Every way the link may be followed is refused, and nothing is made where it points. */
async function refusedThrough(cache: string, outside: string, by?: string) {
  const refusal = await storeRoot(cache).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(refusal).toMatchObject({ code: expect.stringMatching(REFUSED) });
  if (by !== undefined)
    expect((refusal as Error).message).toContain(`lies in the checkout ${by}`);
  await expect(
    openStableDirectory(join(cache, 'openpacker')),
  ).rejects.toMatchObject({ code: expect.stringMatching(REFUSED) });
  await expect(writeFileAtomic(join(cache, 'note'), 'x')).rejects.toMatchObject(
    { code: expect.stringMatching(REFUSED) },
  );
  expect(await readdir(outside, { recursive: true })).toEqual([]);
}

describe.runIf(POSIX)(
  'a nested repository leaves no outer checkout unfenced',
  () => {
    it('fences a submodule’s superproject, whose link XDG_CACHE_HOME names, when the command runs in the submodule', async () => {
      const base = await world();
      const superproject = join(base, 'super');
      const outside = join(base, 'outside');
      await mkdir(join(superproject, '.git', 'modules', 'lib'), {
        recursive: true,
      });
      const cache = await linkedCache(superproject, outside);
      const lib = join(superproject, 'vendor', 'lib');
      await mkdir(lib, { recursive: true });
      await writeFile(join(lib, '.git'), 'gitdir: ../../.git/modules/lib\n');
      await writeFile(join(lib, 'package.json'), '{}');
      vi.stubEnv('XDG_CACHE_HOME', cache);

      beginCommand(lib);
      await refusedThrough(cache, outside, superproject);
      expect(fenceWorkingProject(lib)).toEqual(
        expect.arrayContaining([lib, superproject]),
      );
    });

    it('fences the main work tree a worktree nested in it belongs to', async () => {
      const base = await world();
      const main = join(base, 'main');
      const outside = join(base, 'outside');
      await mkdir(join(main, '.git', 'worktrees', 'feature'), {
        recursive: true,
      });
      await writeFile(
        join(main, '.git', 'worktrees', 'feature', 'commondir'),
        '../..\n',
      );
      const cache = await linkedCache(main, outside);
      const feature = join(main, '.worktrees', 'feature');
      await mkdir(feature, { recursive: true });
      await writeFile(
        join(feature, '.git'),
        `gitdir: ${join(main, '.git', 'worktrees', 'feature')}\n`,
      );
      await writeFile(join(feature, 'package.json'), '{}');
      vi.stubEnv('XDG_CACHE_HOME', cache);

      beginCommand(feature);
      await refusedThrough(cache, outside, main);
    });

    it('follows a gitfile back to a main work tree and a superproject that are not its ancestors', async () => {
      const base = await world();
      vi.stubEnv('HOME', base);
      const main = join(base, 'main');
      await mkdir(join(main, '.git', 'worktrees', 'feature'), {
        recursive: true,
      });
      await writeFile(
        join(main, '.git', 'worktrees', 'feature', 'commondir'),
        '../..\n',
      );
      const feature = join(base, 'feature');
      await mkdir(feature);
      await writeFile(
        join(feature, '.git'),
        'gitdir: ../main/.git/worktrees/feature\n',
      );
      const superproject = join(base, 'super');
      await mkdir(join(superproject, '.git', 'modules', 'lib'), {
        recursive: true,
      });
      const lib = join(base, 'lib');
      await mkdir(lib);
      await writeFile(
        join(lib, '.git'),
        `gitdir: ${join(superproject, '.git', 'modules', 'lib')}\n`,
      );

      expect(fenceWorkingProject(feature)).toEqual(
        expect.arrayContaining([feature, main]),
      );
      expect(fenceWorkingProject(lib)).toEqual(
        expect.arrayContaining([lib, superproject]),
      );
    });
  },
);

describe.runIf(POSIX)('a base the environment names inside a checkout', () => {
  it('is refused through a link the checkout holds wherever the command runs', async () => {
    const base = await world();
    const repo = join(base, 'repo');
    const outside = join(base, 'outside');
    await mkdir(join(repo, '.git'), { recursive: true });
    const cache = await linkedCache(repo, outside);
    const elsewhere = join(base, 'home', 'elsewhere');
    await mkdir(elsewhere);
    vi.stubEnv('XDG_CACHE_HOME', cache);

    beginCommand(elsewhere);
    await refusedThrough(cache, outside, repo);
    expect(fenceWorkingProject(elsewhere)).toContain(repo);
  });

  it('is refused through a link in a checkout with no command begun at all', async () => {
    const base = await world();
    const repo = join(base, 'repo');
    const outside = join(base, 'outside');
    await mkdir(join(repo, '.git'), { recursive: true });
    const cache = await linkedCache(repo, outside);
    vi.stubEnv('XDG_CACHE_HOME', cache);

    expect(realBase(cache)).toBe(cache);
    await refusedThrough(cache, outside, repo);
  });

  it.runIf(glibcLinux())(
    'is refused the same through the C library’s *at calls (the macOS road)',
    async () => {
      const base = await world();
      const repo = join(base, 'repo');
      const outside = join(base, 'outside');
      await mkdir(join(repo, '.git'), { recursive: true });
      const cache = await linkedCache(repo, outside);
      const restore = useResolverOpsForTesting(
        libcDirectoryOps(linuxGlibcProfile()),
      );
      try {
        expect(realBase(cache)).toBe(cache);
        expect(realBase(join(base, 'home'))).toBe(join(base, 'home'));
      } finally {
        restore();
      }
    },
  );

  it('is reached through a link of the person’s own, outside every checkout', async () => {
    const base = await world();
    const home = join(base, 'home');
    await mkdir(join(base, 'cache-real'));
    await symlink(join(base, 'cache-real'), join(home, '.cache'));
    await mkdir(join(home, 'work'));
    vi.stubEnv('XDG_CACHE_HOME', join(home, '.cache'));

    beginCommand(join(home, 'work'));
    await storeRoot(join(home, '.cache'));
    expect(await readdir(join(base, 'cache-real', 'openpacker'))).toEqual([
      'store',
    ]);
  });
});

describe.runIf(POSIX)(
  'a home directory that is a checkout or lies in one',
  () => {
    it.each([
      ['is the checkout, XDG_CACHE_HOME named in it (F3)', '.', true],
      ['lies inside the checkout (F3b)', '.home', true],
      [
        'is the checkout, its default ~/.cache the committed link (F3c)',
        '.',
        false,
      ],
    ] as const)('%s: refused, naming the checkout', async (_, home, named) => {
      const base = await world();
      const checkout = join(base, 'checkout');
      const outside = join(base, 'outside');
      await mkdir(join(checkout, '.git'), { recursive: true });
      const cache = await linkedCache(checkout, outside);
      await mkdir(join(checkout, home), { recursive: true });
      vi.stubEnv('HOME', join(checkout, home));
      if (named) vi.stubEnv('XDG_CACHE_HOME', cache);

      beginCommand(checkout);
      await refusedThrough(cache, outside, checkout);
      expect(fenceWorkingProject(checkout)).toContain(checkout);
    });

    it('keeps the person’s links when the home directory holds no .git', async () => {
      const base = await world();
      const home = join(base, 'home');
      await mkdir(join(base, 'cache-real'));
      await symlink(join(base, 'cache-real'), join(home, '.cache'));

      beginCommand(home);
      await storeRoot(join(home, '.cache'));
      expect(await readdir(join(base, 'cache-real'))).toEqual(['openpacker']);
    });
  },
);

describe.runIf(POSIX)(
  'a tree with no .git (an archive, a Docker context)',
  () => {
    it('is fenced from its topmost directory below the home or temporary directory, so a link at its root names no base (F4)', async () => {
      const base = await world();
      const repo = join(base, 'repo');
      const outside = join(base, 'outside');
      const cache = await linkedCache(repo, outside);
      await writeFile(join(repo, 'package.json'), '{}');
      const pkg = join(repo, 'packages', 'a');
      await mkdir(pkg, { recursive: true });
      await writeFile(join(pkg, 'package.json'), '{}');
      vi.stubEnv('XDG_CACHE_HOME', cache);

      beginCommand(pkg);
      await refusedThrough(cache, outside);
      expect(fenceWorkingProject(pkg)).toEqual(
        expect.arrayContaining([pkg, base]),
      );
    });

    it('is fenced though a nested checkout holds the working directory', async () => {
      const base = await world();
      const repo = join(base, 'repo');
      const outside = join(base, 'outside');
      const cache = await linkedCache(repo, outside);
      const lib = join(repo, 'vendor', 'lib');
      await mkdir(join(lib, '.git'), { recursive: true });
      vi.stubEnv('XDG_CACHE_HOME', cache);

      beginCommand(lib);
      await refusedThrough(cache, outside);
    });

    it('is fenced when it is the temporary directory itself and holds a marker', async () => {
      const base = await world();
      const temporary = join(base, 'tmp');
      const outside = join(base, 'outside');
      const cache = await linkedCache(temporary, outside);
      await writeFile(join(temporary, 'package.json'), '{}');
      const pkg = join(temporary, 'packages', 'a');
      await mkdir(pkg, { recursive: true });
      await writeFile(join(pkg, 'package.json'), '{}');
      vi.stubEnv('TMPDIR', temporary);
      vi.stubEnv('XDG_CACHE_HOME', cache);

      beginCommand(pkg);
      await refusedThrough(cache, outside);
      expect(fenceWorkingProject(pkg)).toContain(temporary);
    });

    it('is the topmost directory below the deepest home or temporary directory that holds it, else below the root', () => {
      expect(
        topmostBelow('/workspace/repo/packages/a', ['/home/u', '/tmp']),
      ).toBe('/workspace');
      expect(topmostBelow('/home/u/code/repo/a', ['/home/u', '/tmp'])).toBe(
        '/home/u/code',
      );
      expect(topmostBelow('/tmp/build/repo/a', ['/home/u', '/tmp'])).toBe(
        '/tmp/build',
      );
      expect(
        topmostBelow('/home/u/tmp/run/repo', ['/home/u', '/home/u/tmp']),
      ).toBe('/home/u/tmp/run');
      expect(topmostBelow('/home/u', ['/home/u'])).toBeUndefined();
      expect(topmostBelow('/', [])).toBeUndefined();
      expect(topmostBelow('/home/user2/x', ['/home/u'])).toBe('/home');
    });
  },
);

describe.runIf(POSIX)(
  'a work tree git is told of with GIT_DIR and GIT_WORK_TREE (F7)',
  () => {
    /** `<base>/tree`, with no .git, holding `.cache -> outside`; its repository at `<base>/repo.git`. */
    async function tree(base: string) {
      const work = join(base, 'tree');
      const outside = join(base, 'outside');
      const cache = await linkedCache(work, outside);
      await mkdir(join(base, 'repo.git'));
      const pkg = join(work, 'packages', 'a');
      await mkdir(pkg, { recursive: true });
      await writeFile(join(pkg, 'package.json'), '{}');
      vi.stubEnv('XDG_CACHE_HOME', cache);
      return { work, outside, cache, pkg, repository: join(base, 'repo.git') };
    }

    it('fences GIT_WORK_TREE, wherever the command runs in it', async () => {
      const base = await world();
      const { work, outside, cache, pkg, repository } = await tree(base);
      vi.stubEnv('GIT_DIR', repository);
      vi.stubEnv('GIT_WORK_TREE', work);

      beginCommand(pkg);
      await refusedThrough(cache, outside);
      expect(fenceWorkingProject(pkg)).toEqual(
        expect.arrayContaining([work, base]),
      );
    });

    it('fences GIT_WORK_TREE from outside it, where nothing else would', async () => {
      const base = await world();
      vi.stubEnv('HOME', base);
      const { work, outside, cache, repository } = await tree(base);
      const elsewhere = join(base, 'elsewhere');
      await mkdir(elsewhere);
      vi.stubEnv('GIT_DIR', repository);
      vi.stubEnv('GIT_WORK_TREE', work);

      beginCommand(elsewhere);
      await refusedThrough(cache, outside);
    });

    it('with GIT_DIR alone, fences the working directory, core.worktree and the directory that holds GIT_DIR', async () => {
      const base = await world();
      vi.stubEnv('HOME', base);
      const { work, repository } = await tree(base);
      const configured = join(base, 'configured');
      await mkdir(configured);
      await writeFile(
        join(repository, 'config'),
        '[core]\n\tbare = false\n\tworktree = ../configured\n',
      );
      vi.stubEnv('GIT_DIR', repository);

      expect(fenceWorkingProject(work)).toEqual(
        expect.arrayContaining([work, configured, base]),
      );
    });
  },
);

describe.runIf(POSIX && ROOT)(
  'a link another user may have made, in a directory others may write to',
  () => {
    /** `<base>/shared` (mode `mode`) holding `tc -> <base>/victim-private`, owned by `owner`. */
    async function sharedLink(mode: number, owner: number) {
      const base = await world();
      const shared = join(base, 'shared');
      await mkdir(shared);
      await chmod(shared, mode);
      const victim = join(base, 'victim-private');
      await mkdir(victim, { mode: 0o700 });
      const link = join(shared, 'tc');
      await symlink(victim, link);
      await lchown(link, owner, owner);
      return { link, victim };
    }

    it.each([
      ['writable by anyone, not sticky', 0o777],
      ['writable by its group', 0o770],
      ['sticky and writable by anyone', 0o1777],
    ])(
      'is not followed in a directory %s when neither the user nor root owns it',
      async (_, mode) => {
        const { link, victim } = await sharedLink(mode, NOBODY);

        expect(realBase(link)).toBe(link);
        // The last component of a tool cache or a config root, taken as it may be.
        await expect(
          openRootDirectory(link, { create: true, lastMayBeLink: true }),
        ).rejects.toMatchObject({ code: expect.stringMatching(REFUSED) });
        trustBase(link, 'project root');
        await expect(
          writeFileAtomic(join(link, 'x.json'), '{}'),
        ).rejects.toMatchObject({ code: expect.stringMatching(REFUSED) });
        expect(await readdir(victim)).toEqual([]);
      },
    );

    it('is followed when the user or root owns it, or when only its owner may write the directory', async () => {
      expect(realBase((await sharedLink(0o777, 0)).link)).toMatch(
        /victim-private$/u,
      );
      forgetBases();
      expect(
        realBase((await sharedLink(0o777, process.geteuid!())).link),
      ).toMatch(/victim-private$/u);
      forgetBases();
      expect(realBase((await sharedLink(0o755, NOBODY)).link)).toMatch(
        /victim-private$/u,
      );
    });

    it.runIf(glibcLinux())(
      'is judged the same through the C library’s *at calls (the macOS road)',
      async () => {
        const restore = useResolverOpsForTesting(
          libcDirectoryOps(linuxGlibcProfile()),
        );
        try {
          const theirs = await sharedLink(0o777, NOBODY);
          expect(realBase(theirs.link)).toBe(theirs.link);
        } finally {
          restore();
        }
      },
    );
  },
);

describe.runIf(POSIX)('two commands running at once in one process', () => {
  it('never drop each other’s fences or bases, and the next command after both forgets them', async () => {
    const base = await world();
    vi.stubEnv('HOME', base);
    // The first command's project, protected by its fence alone: no .git.
    const first = join(base, 'first');
    const outside = join(base, 'outside');
    const cache = await linkedCache(first, outside);
    await writeFile(join(first, 'package.json'), '{}');
    // A root the first command takes, itself a link, as a project root may be.
    await mkdir(join(base, 'real-root'));
    await symlink(join(base, 'real-root'), join(base, 'root-link'));
    const second = join(base, 'second');
    await mkdir(second);
    vi.stubEnv('XDG_CACHE_HOME', cache);

    const endFirst = beginCommand(first);
    expect(trustBase(join(base, 'root-link'), 'project root')).toBe(
      join(base, 'real-root'),
    );
    const endSecond = beginCommand(second);
    // The first is still running: its fence holds, and its root is still taken.
    await refusedThrough(cache, outside);
    await (await openStableDirectory(join(base, 'root-link'))).close();
    endSecond();
    await refusedThrough(cache, outside);
    endFirst();
    endFirst();

    // Nothing is running now: a command begun elsewhere starts afresh.
    const endThird = beginCommand(second);
    expect(realBase(cache)).toBe(outside);
    endThird();
  });
});

describe.runIf(process.platform === 'linux' && ROOT)(
  'a checkout found by its .git, however it is named',
  () => {
    it('is the same checkout through a bind mount of it', async () => {
      const base = await world();
      const repo = join(base, 'repo');
      const outside = join(base, 'outside');
      await mkdir(join(repo, '.git'), { recursive: true });
      await linkedCache(repo, outside);
      const alias = join(base, 'alias');
      await mkdir(alias);
      try {
        execFileSync('mount', ['--bind', repo, alias], { stdio: 'ignore' });
      } catch {
        return;
      }
      try {
        expect(realBase(join(alias, '.cache'))).toBe(join(alias, '.cache'));
        expect(await readdir(outside)).toEqual([]);
      } finally {
        execFileSync('umount', [alias], { stdio: 'ignore' });
      }
    });
  },
);
