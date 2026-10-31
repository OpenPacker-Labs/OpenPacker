/**
 * What no base is resolved through: a link in a fence (a project, a root
 * taken), however the fenced directory is named and whenever the fence came,
 * and a link another user put in a sticky directory anyone may write to.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import {
  chmod,
  lchown,
  mkdir,
  mkdtemp,
  readFile,
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
import { procOps, useResolverOpsForTesting } from './base-resolve.js';
import { linuxGlibcProfile } from './handle-libc-profile.js';
import { glibcLinux } from './handle-test-support.js';
import {
  BASE_VARIABLES,
  beginCommand,
  fenceWorkingProject,
  forgetBases,
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
const mounts: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  forgetBases();
  for (const mount of mounts.splice(0))
    execFileSync('umount', [mount], { stdio: 'ignore' });
  for (const world of worlds.splice(0))
    await rm(world, { recursive: true, force: true });
});

async function world(): Promise<string> {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'fences-'));
  worlds.push(dir);
  for (const name of BASE_VARIABLES) vi.stubEnv(name, '');
  return dir;
}

/** Whether this process may bind-mount (root in a namespace that allows it). */
const canBindMount: boolean = (() => {
  if (process.platform !== 'linux' || !ROOT) return false;
  const dir = mkdtempSync(join(tmpdir(), 'fences-probe-'));
  try {
    execFileSync('mkdir', ['-p', join(dir, 'a'), join(dir, 'b')]);
    execFileSync('mount', ['--bind', join(dir, 'a'), join(dir, 'b')], {
      stdio: 'ignore',
    });
    execFileSync('umount', [join(dir, 'b')], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

/** `<base>/project` holding `.cache -> <base>/outside`. */
async function projectHoldingLink(
  base: string,
): Promise<{ root: string; outside: string }> {
  const root = join(base, 'project');
  const outside = join(base, 'outside');
  await mkdir(root);
  await mkdir(outside);
  await symlink(outside, join(root, '.cache'));
  return { root, outside };
}

describe.runIf(canBindMount)('a fence is the directory, not its name', () => {
  it('holds when the project is named through a bind mount of it', async () => {
    const base = await world();
    const { root, outside } = await projectHoldingLink(base);
    const alias = join(base, 'alias');
    await mkdir(alias);
    execFileSync('mount', ['--bind', root, alias]);
    mounts.push(alias);
    trustBase(root, 'project root');
    vi.stubEnv('XDG_CACHE_HOME', join(alias, '.cache'));

    expect(realBase(join(alias, '.cache'))).toBe(join(alias, '.cache'));
    await expect(
      openStableDirectory(join(alias, '.cache', 'openpacker')),
    ).rejects.toMatchObject({ code: expect.stringMatching(REFUSED) });
    await expect(
      writeFileAtomic(join(alias, '.cache', 'auth.json'), '{}'),
    ).rejects.toMatchObject({ code: expect.stringMatching(REFUSED) });
    expect(await readdir(outside)).toEqual([]);
  });
});

describe.runIf(POSIX)('a fence is kept for the whole command', () => {
  it('outlives any number of other bases taken after it', async () => {
    const base = await world();
    const { root, outside } = await projectHoldingLink(base);
    trustBase(root, 'project root');
    const others = join(base, 'others');
    for (let index = 0; index < 600; index += 1) {
      await mkdir(join(others, String(index)), { recursive: true });
      trustBase(join(others, String(index)), 'project root');
    }
    vi.stubEnv('XDG_CACHE_HOME', join(root, '.cache'));

    await expect(
      openStableDirectory(join(root, '.cache', 'openpacker')),
    ).rejects.toMatchObject({ code: expect.stringMatching(REFUSED) });
    expect(await readdir(outside)).toEqual([]);
  });

  it('unmakes a base taken through its link before it came', async () => {
    const base = await world();
    const { root, outside } = await projectHoldingLink(base);
    // A store root named inside the project, taken before the project was.
    const store = join(root, '.cache', 'store');
    await mkdir(join(outside, 'store'));
    trustBase(store, 'validated private root');
    trustBase(root, 'project root');

    await expect(
      openStableDirectory(join(store, 'entry')),
    ).rejects.toMatchObject({ code: expect.stringMatching(REFUSED) });
    await expect(
      writeFileAtomic(join(store, 'entry.json'), '{}'),
    ).rejects.toMatchObject({ code: expect.stringMatching(REFUSED) });
    expect(await readdir(join(outside, 'store'))).toEqual([]);
  });
});

describe.runIf(POSIX)('the project a command runs in', () => {
  it('is fenced before any base is resolved, so a link it holds names no base', async () => {
    const base = await world();
    const { root, outside } = await projectHoldingLink(base);
    await mkdir(join(root, '.git'));
    await mkdir(join(root, 'src'));
    vi.stubEnv('HOME', join(base, 'home'));
    vi.stubEnv('XDG_CACHE_HOME', join(root, '.cache'));

    beginCommand(join(root, 'src'));
    await expect(
      openStableDirectory(join(root, '.cache', 'openpacker', 'x')),
    ).rejects.toMatchObject({ code: expect.stringMatching(REFUSED) });
    expect(await readdir(outside)).toEqual([]);
  });

  it('is the nearest directory with a project marker above the working directory, else the working directory, with the checkout that holds it and the tree it runs in', async () => {
    const base = await world();
    // The world is the home directory, so the tree each command runs in is
    // the world's child that holds it (`repo`, `loose`).
    vi.stubEnv('HOME', base);
    await mkdir(join(base, 'repo', 'packages', 'a', 'src'), {
      recursive: true,
    });
    await writeFile(join(base, 'repo', 'package.json'), '{}');
    await writeFile(join(base, 'repo', 'packages', 'a', 'package.json'), '{}');
    const src = join(base, 'repo', 'packages', 'a', 'src');
    expect(fenceWorkingProject(src)).toEqual([
      join(base, 'repo', 'packages', 'a'),
      join(base, 'repo'),
    ]);
    await mkdir(join(base, 'repo', '.git'));
    forgetBases();
    expect(fenceWorkingProject(src)).toEqual([
      join(base, 'repo', 'packages', 'a'),
      join(base, 'repo'),
    ]);
    await mkdir(join(base, 'loose'));
    expect(fenceWorkingProject(join(base, 'loose'))).toEqual([
      join(base, 'loose'),
    ]);
  });

  it.each(['a directory', 'a gitfile, as a worktree has'])(
    'fences a monorepo’s checkout root, its .git %s, though the command runs in one of its packages',
    async (kind) => {
      const base = await world();
      const { root, outside } = await projectHoldingLink(base);
      if (kind === 'a directory') await mkdir(join(root, '.git'));
      else
        await writeFile(
          join(root, '.git'),
          `gitdir: ${join(base, 'main', '.git', 'worktrees', 'project')}\n`,
        );
      const pkg = join(root, 'packages', 'a');
      await mkdir(pkg, { recursive: true });
      await writeFile(join(pkg, 'package.json'), '{}');
      vi.stubEnv('HOME', join(base, 'home'));
      vi.stubEnv('XDG_CACHE_HOME', join(root, '.cache'));

      beginCommand(pkg);
      await expect(
        openStableDirectory(join(root, '.cache', 'openpacker', 'x')),
      ).rejects.toMatchObject({ code: expect.stringMatching(REFUSED) });
      await expect(
        writeFileAtomic(join(root, '.cache', 'note'), 'x'),
      ).rejects.toMatchObject({ code: expect.stringMatching(REFUSED) });
      expect(await readdir(outside)).toEqual([]);
    },
  );

  it('is never a home directory that is no checkout, a directory above it or the root: the person’s own links stay theirs', async () => {
    const base = await world();
    const home = join(base, 'home');
    await mkdir(home);
    await mkdir(join(base, 'cache-real'));
    await symlink(join(base, 'cache-real'), join(home, '.cache'));
    await mkdir(join(home, 'work'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('XDG_CACHE_HOME', join(home, '.cache'));

    beginCommand(join(home, 'work'));
    beginCommand(home);
    expect(fenceWorkingProject('/')).toEqual([]);
    await writeFileAtomic(join(home, '.cache', 'note'), 'x');
    expect(await readFile(join(base, 'cache-real', 'note'), 'utf8')).toBe('x');
  });
});

describe.runIf(POSIX && ROOT)(
  'a link in a sticky directory anyone may write to',
  () => {
    async function stickyLink(owner: number, directoryOwner = 0) {
      const base = await world();
      const sticky = join(base, 'shared');
      await mkdir(sticky);
      await chmod(sticky, 0o1777);
      await lchown(sticky, directoryOwner, directoryOwner);
      const target = join(base, 'target');
      await mkdir(target);
      const link = join(sticky, 'tmp');
      await symlink(target, link);
      await lchown(link, owner, owner);
      return { link, target };
    }

    it('is not followed when another user owns it, whatever fs.protected_symlinks says', async () => {
      const { link, target } = await stickyLink(NOBODY);
      vi.stubEnv('TMPDIR', link);

      expect(realBase(link)).toBe(link);
      await expect(
        writeFileAtomic(join(tmpdir(), 'file'), 'x'),
      ).rejects.toMatchObject({ code: expect.stringMatching(REFUSED) });
      trustBase(link, 'project root');
      await expect(
        openStableDirectory(join(link, 'project')),
      ).rejects.toMatchObject({ code: expect.stringMatching(REFUSED) });
      expect(await readdir(target)).toEqual([]);
    });

    it('is followed when it belongs to the user, or to the directory’s owner', async () => {
      const own = await stickyLink(process.geteuid!());
      expect(realBase(own.link)).toBe(own.target);
      forgetBases();
      const directoryOwners = await stickyLink(NOBODY, NOBODY);
      expect(realBase(directoryOwners.link)).toBe(directoryOwners.target);
    });

    it.runIf(glibcLinux())(
      'is judged the same through the C library’s *at calls (the macOS road)',
      async () => {
        const restore = useResolverOpsForTesting(
          libcDirectoryOps(linuxGlibcProfile()),
        );
        try {
          const theirs = await stickyLink(NOBODY);
          expect(realBase(theirs.link)).toBe(theirs.link);
          forgetBases();
          const mine = await stickyLink(process.geteuid!());
          expect(realBase(mine.link)).toBe(mine.target);
        } finally {
          restore();
        }
      },
    );
  },
);

describe.runIf(glibcLinux())(
  'the C library’s resolution (the macOS road)',
  () => {
    it('finds what /proc/self/fd finds, links on the way and the macOS /var shape included', async () => {
      const base = await world();
      await mkdir(join(base, 'private', 'var', 'folders', 'T'), {
        recursive: true,
      });
      await symlink('private/var', join(base, 'var'));
      await symlink(join(base, 'var', 'folders'), join(base, 'folders-link'));
      const paths = [
        join(base, 'var', 'folders', 'T'),
        join(base, 'folders-link', 'T', 'missing', 'x'),
        join(base, 'var', '..', 'private'),
      ];
      const proc = paths.map((path) => realBase(path));
      const restore = useResolverOpsForTesting(
        libcDirectoryOps(linuxGlibcProfile()),
      );
      try {
        expect(paths.map((path) => realBase(path))).toEqual(proc);
      } finally {
        restore();
      }
      expect(proc[0]).toBe(join(base, 'private', 'var', 'folders', 'T'));
      expect(procOps.id).toBe('proc-fd');
    });
  },
);
