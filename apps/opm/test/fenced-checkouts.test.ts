import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { enableDefaultSharedStore } from '@openpacker/opm-project';
import { NpmRegistryFixture } from '../../../packages/opm-project/test/npm-registry-fixture.js';
import { runOpm } from '../src/opm.js';
import { runOpmx } from '../src/opmx.js';

/**
 * A link committed in a checkout (`.cache -> <outside>`) that the
 * environment names a cache through, in the layouts the third review of
 * trusted bases found leaking (ADR 0034): a submodule and a nested worktree,
 * whose outer checkout holds the link; a home directory that is the checkout
 * or lies in it; a tree with no `.git`; a work tree named by `GIT_WORK_TREE`;
 * and a cache named inside a checkout the command does not run in. In each,
 * `opmx pkg:…` made its tool cache and the shared store where the link
 * points, and exited 0 or 9 after doing so. Now each is refused and nothing
 * is made outside; `opm add` keeps the project's own store.
 */

const POSIX = process.platform === 'linux' || process.platform === 'darwin';

const worlds: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  enableDefaultSharedStore(false);
  for (const dir of worlds.splice(0))
    await rm(dir, { recursive: true, force: true });
});

function captured() {
  const seen = { out: '', err: '' };
  return {
    seen,
    io: {
      stdout: { write: (chunk: string) => ((seen.out += chunk), true) },
      stderr: { write: (chunk: string) => ((seen.err += chunk), true) },
    },
  };
}

/** A world with an empty `outside`, its own home, and no store or cache named but the default. */
async function world(): Promise<{ base: string; outside: string }> {
  const base = await mkdtemp(join(await realpath(tmpdir()), 'opm-checkouts-'));
  worlds.push(base);
  await mkdir(join(base, 'outside'));
  await mkdir(join(base, 'home'));
  for (const name of [
    'OPM_STORE_HOME',
    'OPM_TOOL_CACHE',
    'GIT_DIR',
    'GIT_WORK_TREE',
    'XDG_CACHE_HOME',
  ])
    vi.stubEnv(name, '');
  vi.stubEnv('HOME', join(base, 'home'));
  enableDefaultSharedStore(true);
  return { base, outside: join(base, 'outside') };
}

/** `<dir>/.cache -> <outside>`, committed. */
async function linkCache(dir: string, outside: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  await symlink(outside, join(dir, '.cache'));
  return join(dir, '.cache');
}

const registry = () =>
  new NpmRegistryFixture([
    {
      name: 'tool',
      versions: {
        '1.0.0': {
          bin: { tool: 'cli.js' },
          files: { 'cli.js': "process.stdout.write('ran\\n');\n" },
        },
      },
    },
  ]);

/** `opmx pkg:npm/tool@1.0.0` in `cwd`: refused, nothing made where the link points. */
async function opmxRefused(cwd: string, outside: string): Promise<string> {
  const { seen, io } = captured();
  const exit = await runOpmx(['pkg:npm/tool@1.0.0'], io, cwd, {
    registryOptions: { transport: registry() },
  });
  expect(await readdir(outside, { recursive: true })).toEqual([]);
  expect(exit, seen.err).not.toBe(0);
  expect(seen.err).toMatch(/linked|ENOTDIR|ELOOP/iu);
  return seen.err;
}

const fixtureTgz = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../fixtures/opm/demo-tool-1.1.0.tgz',
);
const DEMO = 'pkg:npm/@openpacker/demo-tool@1.1.0';

/** `opm init` in `pkg`, then `opm add` of the demo tool offline: it succeeds with the project's own store, and nothing is made outside. */
async function addKeepsOwnStore(pkg: string, outside: string): Promise<void> {
  expect(await runOpm(['init', '--name', 'a'], captured().io, pkg)).toBe(0);
  const bytes = await readFile(fixtureTgz);
  await mkdir(join(pkg, '.opm'), { recursive: true });
  await writeFile(
    join(pkg, '.opm/catalog.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      packages: {
        [DEMO]: {
          purl: DEMO,
          version: '1.1.0',
          digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
          size: bytes.byteLength,
          format: 'tar+gzip',
          mediaType: 'application/vnd.npm.package+gzip',
          source: `file:${fixtureTgz}`,
          bins: [{ name: 'demo-tool', path: 'package/bin/demo-tool.js' }],
        },
      },
    })}\n`,
  );
  const { seen, io } = captured();
  const exit = await runOpm(['add', DEMO, '--offline'], io, pkg);
  expect(await readdir(outside, { recursive: true })).toEqual([]);
  expect(exit, seen.err).toBe(0);
}

/** `super/` (a checkout committing the link) and its submodule `super/vendor/lib`, a project. */
async function submodule() {
  const { base, outside } = await world();
  const superproject = join(base, 'super');
  await mkdir(join(superproject, '.git', 'modules', 'lib'), {
    recursive: true,
  });
  vi.stubEnv('XDG_CACHE_HOME', await linkCache(superproject, outside));
  const lib = join(superproject, 'vendor', 'lib');
  await mkdir(lib, { recursive: true });
  await writeFile(join(lib, '.git'), 'gitdir: ../../.git/modules/lib\n');
  await writeFile(
    join(lib, 'package.json'),
    '{"name":"lib","version":"0.0.0"}\n',
  );
  return { superproject, lib, outside };
}

/** `main/` (a checkout committing the link) and its worktree `main/.worktrees/feature`, a project. */
async function nestedWorktree() {
  const { base, outside } = await world();
  const main = join(base, 'main');
  const gitdir = join(main, '.git', 'worktrees', 'feature');
  await mkdir(gitdir, { recursive: true });
  await writeFile(join(gitdir, 'commondir'), '../..\n');
  vi.stubEnv('XDG_CACHE_HOME', await linkCache(main, outside));
  const feature = join(main, '.worktrees', 'feature');
  await mkdir(feature, { recursive: true });
  await writeFile(join(feature, '.git'), `gitdir: ${gitdir}\n`);
  await writeFile(
    join(feature, 'package.json'),
    '{"name":"feature","version":"0.0.0"}\n',
  );
  return { main, feature, outside };
}

describe.runIf(POSIX)(
  'a nested repository whose outer checkout holds the link (B-1)',
  () => {
    it('opmx pkg:… in a submodule makes no tool cache or store through the superproject’s link', async () => {
      const { superproject, lib, outside } = await submodule();
      expect(await opmxRefused(lib, outside)).toContain(superproject);
    });

    it('opm add in a submodule keeps its own store', async () => {
      const { lib, outside } = await submodule();
      await addKeepsOwnStore(lib, outside);
    });

    it('opmx pkg:… in a worktree nested in its main work tree makes nothing through the main work tree’s link', async () => {
      const { main, feature, outside } = await nestedWorktree();
      expect(await opmxRefused(feature, outside)).toContain(main);
    });

    it('opm add in a nested worktree keeps its own store', async () => {
      const { feature, outside } = await nestedWorktree();
      await addKeepsOwnStore(feature, outside);
    });
  },
);

describe.runIf(POSIX)(
  'a home directory that is the checkout or lies in it (F3)',
  () => {
    /** `checkout/` (`.git` a directory) holding the link, and HOME at `home` below it. */
    async function homeIn(home: string, named: boolean) {
      const { base, outside } = await world();
      const checkout = join(base, 'checkout');
      await mkdir(join(checkout, '.git'), { recursive: true });
      const cache = await linkCache(checkout, outside);
      await mkdir(join(checkout, home), { recursive: true });
      vi.stubEnv('HOME', join(checkout, home));
      if (named) vi.stubEnv('XDG_CACHE_HOME', cache);
      return { checkout, outside };
    }

    it.each([
      ['HOME is the checkout, XDG_CACHE_HOME the link (F3)', '.', true],
      ['HOME lies inside the checkout (F3b)', '.home', true],
      [
        'HOME is the checkout and ~/.cache the link, nothing named (F3c)',
        '.',
        false,
      ],
    ] as const)(
      '%s: opmx pkg:… is refused, naming the checkout',
      async (_, home, named) => {
        const { checkout, outside } = await homeIn(home, named);
        const said = await opmxRefused(checkout, outside);
        expect(said).toContain(`lies in the checkout ${checkout}`);
        expect(said).toMatch(/OPM_STORE_HOME, OPM_TOOL_CACHE/u);
      },
    );
  },
);

describe.runIf(POSIX)(
  'a tree with no .git, an archive or a Docker context (F4)',
  () => {
    async function archive() {
      const { base, outside } = await world();
      const repo = join(base, 'repo');
      vi.stubEnv('XDG_CACHE_HOME', await linkCache(repo, outside));
      await writeFile(
        join(repo, 'package.json'),
        '{"name":"repo","version":"0.0.0"}\n',
      );
      const pkg = join(repo, 'packages', 'a');
      await mkdir(pkg, { recursive: true });
      await writeFile(
        join(pkg, 'package.json'),
        '{"name":"a","version":"0.0.0"}\n',
      );
      return { pkg, outside };
    }

    it('opmx pkg:… in one of its packages makes nothing through the link at its root', async () => {
      const { pkg, outside } = await archive();
      await opmxRefused(pkg, outside);
    });

    it('opm add in one of its packages keeps its own store', async () => {
      const { pkg, outside } = await archive();
      await addKeepsOwnStore(pkg, outside);
    });
  },
);

describe.runIf(POSIX)(
  'a work tree named by GIT_DIR and GIT_WORK_TREE, with no .git in it (F7)',
  () => {
    it.each(['in a package of the work tree', 'outside the work tree'])(
      'opmx pkg:… run %s makes nothing through the work tree’s link',
      async (where) => {
        const { base, outside } = await world();
        // The home directory holds the world: the tree a command runs in is
        // then the world's child, so only GIT_WORK_TREE fences the work tree
        // when the command runs elsewhere.
        vi.stubEnv('HOME', base);
        const work = join(base, 'tree');
        vi.stubEnv('XDG_CACHE_HOME', await linkCache(work, outside));
        await mkdir(join(base, 'repo.git'));
        const pkg = join(work, 'packages', 'a');
        await mkdir(pkg, { recursive: true });
        await writeFile(
          join(pkg, 'package.json'),
          '{"name":"a","version":"0.0.0"}\n',
        );
        const elsewhere = join(base, 'elsewhere');
        await mkdir(elsewhere);
        vi.stubEnv('GIT_DIR', join(base, 'repo.git'));
        vi.stubEnv('GIT_WORK_TREE', work);

        await opmxRefused(
          where === 'outside the work tree' ? elsewhere : pkg,
          outside,
        );
      },
    );
  },
);

describe.runIf(POSIX)(
  'a cache named inside a checkout the command does not run in (F8)',
  () => {
    it('opmx pkg:… makes nothing through the checkout’s link', async () => {
      const { base, outside } = await world();
      const repo = join(base, 'repo');
      await mkdir(join(repo, '.git'), { recursive: true });
      vi.stubEnv('XDG_CACHE_HOME', await linkCache(repo, outside));
      const elsewhere = join(base, 'home', 'work');
      await mkdir(elsewhere);

      expect(await opmxRefused(elsewhere, outside)).toContain(repo);
    });
  },
);
