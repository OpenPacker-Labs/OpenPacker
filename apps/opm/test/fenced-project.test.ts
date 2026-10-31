import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
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
 * A checkout that holds a link where the environment names a cache or a
 * configuration directory (`.cache -> /outside`, committed), with no store or
 * tool cache named anywhere else, and opm or opmx run in it. No command takes
 * the project as its root before it reaches the cache, so what keeps the link
 * from being followed is that every command fences the project it runs in
 * first (ADR 0034, trusted bases).
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

/** `<world>/checkout` (a git checkout) holding `<link> -> <world>/outside`. */
async function checkout(link: string): Promise<{
  root: string;
  outside: string;
}> {
  const world = await mkdtemp(join(await realpath(tmpdir()), 'opm-fenced-'));
  worlds.push(world);
  const root = join(world, 'checkout');
  const outside = join(world, 'outside');
  await mkdir(join(root, '.git'), { recursive: true });
  await mkdir(outside);
  await symlink(outside, join(root, link));
  vi.stubEnv('OPM_STORE_HOME', '');
  vi.stubEnv('OPM_TOOL_CACHE', '');
  vi.stubEnv('HOME', join(world, 'home'));
  return { root, outside };
}

describe.runIf(POSIX)('a command run in a checkout that holds a link', () => {
  it('opmx pkg:… makes no tool cache or store where an XDG_CACHE_HOME through the link points', async () => {
    const { root, outside } = await checkout('.cache');
    vi.stubEnv('XDG_CACHE_HOME', join(root, '.cache'));
    enableDefaultSharedStore(true);
    const registry = new NpmRegistryFixture([
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
    const { seen, io } = captured();

    const exit = await runOpmx(['pkg:npm/tool@1.0.0'], io, root, {
      registryOptions: { transport: registry },
    });
    expect(exit, seen.err).not.toBe(0);
    expect(seen.err).toMatch(/linked|unstable|ENOTDIR|ELOOP/iu);
    expect(await readdir(outside, { recursive: true })).toEqual([]);
  });

  it('opm auth set writes no configuration where an XDG_CONFIG_HOME through the link points', async () => {
    const { root, outside } = await checkout('.config');
    vi.stubEnv('OPM_AUTH_CONFIG', '');
    vi.stubEnv('XDG_CONFIG_HOME', join(root, '.config'));
    const { seen, io } = captured();

    const exit = await runOpm(
      ['auth', 'set', '--origin', 'https://npm.internal.example'],
      io,
      root,
    );
    expect(exit, seen.err).not.toBe(0);
    expect(await readdir(outside, { recursive: true })).toEqual([]);
  });
});

describe.runIf(POSIX)(
  'the registry auth configuration in a checkout that holds a link',
  () => {
    it('opm auth list reads none where an XDG_CONFIG_HOME through the link points', async () => {
      const { root, outside } = await checkout('.config');
      vi.stubEnv('OPM_AUTH_CONFIG', '');
      vi.stubEnv('XDG_CONFIG_HOME', join(root, '.config'));
      // What the checkout's author put there: their origin, given this token.
      await mkdir(join(outside, 'openpacker'), { mode: 0o700 });
      await writeFile(
        join(outside, 'openpacker', 'auth.json'),
        `${JSON.stringify({
          version: 1,
          origins: { 'https://attacker.example': { tokenEnv: 'GITHUB_TOKEN' } },
        })}\n`,
        { mode: 0o600 },
      );
      const { seen, io } = captured();

      const exit = await runOpm(['auth', 'list'], io, root);
      expect(seen.out).not.toContain('attacker.example');
      expect(exit, seen.err).not.toBe(0);
      expect(seen.err).toMatch(/linked|ENOTDIR|ELOOP/iu);
    });
  },
);

const fixtureTgz = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../fixtures/opm/demo-tool-1.1.0.tgz',
);
const DEMO = 'pkg:npm/@openpacker/demo-tool@1.1.0';

/**
 * A monorepo checkout (`.git` a directory, or a gitfile as a worktree has)
 * that commits `.cache -> <world>/outside` at its root, and its package
 * `packages/a` with a `package.json` of its own, an opm project that can add
 * the demo tool offline.
 */
async function monorepo(git: 'directory' | 'gitfile'): Promise<{
  root: string;
  pkg: string;
  outside: string;
}> {
  const world = await mkdtemp(join(await realpath(tmpdir()), 'opm-mono-'));
  worlds.push(world);
  const root = join(world, 'repo');
  const outside = join(world, 'outside');
  const pkg = join(root, 'packages', 'a');
  await mkdir(pkg, { recursive: true });
  await mkdir(outside);
  if (git === 'directory') await mkdir(join(root, '.git'));
  else
    await writeFile(
      join(root, '.git'),
      `gitdir: ${join(world, 'main', '.git', 'worktrees', 'repo')}\n`,
    );
  await symlink(outside, join(root, '.cache'));
  await writeFile(
    join(pkg, 'package.json'),
    '{"name":"a","version":"0.0.0"}\n',
  );
  vi.stubEnv('OPM_STORE_HOME', '');
  vi.stubEnv('OPM_TOOL_CACHE', '');
  vi.stubEnv('HOME', join(world, 'home'));
  vi.stubEnv('XDG_CACHE_HOME', join(root, '.cache'));
  enableDefaultSharedStore(true);
  return { root, pkg, outside };
}

/** `opm init` in `pkg`, and a catalog that serves the demo tool from its archive. */
async function demoProject(pkg: string): Promise<void> {
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
}

describe.runIf(POSIX)(
  'a command run in a package of a monorepo whose checkout root holds a link',
  () => {
    it.each(['directory', 'gitfile'] as const)(
      'opmx pkg:… makes no tool cache or store through the root’s link (.git a %s)',
      async (git) => {
        const { pkg, outside } = await monorepo(git);
        const registry = new NpmRegistryFixture([
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
        const { seen, io } = captured();

        const exit = await runOpmx(['pkg:npm/tool@1.0.0'], io, pkg, {
          registryOptions: { transport: registry },
        });
        expect(exit, seen.err).not.toBe(0);
        expect(seen.err).toMatch(/linked|unstable|ENOTDIR|ELOOP/iu);
        expect(await readdir(outside, { recursive: true })).toEqual([]);
      },
    );

    it.each(['directory', 'gitfile'] as const)(
      'opm add keeps the package’s own store, not the default one through the root’s link (.git a %s)',
      async (git) => {
        const { pkg, outside } = await monorepo(git);
        await demoProject(pkg);
        const { seen, io } = captured();

        expect(
          await runOpm(['add', DEMO, '--offline'], io, pkg),
          seen.err,
        ).toBe(0);
        expect(await readdir(outside, { recursive: true })).toEqual([]);
      },
    );

    it.each(['directory', 'gitfile'] as const)(
      'opm add refuses a store OPM_STORE_HOME names through the root’s link (.git a %s)',
      async (git) => {
        const { root, pkg, outside } = await monorepo(git);
        await demoProject(pkg);
        vi.stubEnv('OPM_STORE_HOME', join(root, '.cache', 'store'));
        const { seen, io } = captured();

        expect(
          await runOpm(['add', DEMO, '--offline'], io, pkg),
          seen.err,
        ).not.toBe(0);
        expect(seen.err).toMatch(/linked|unstable|ENOTDIR|ELOOP/iu);
        expect(await readdir(outside, { recursive: true })).toEqual([]);
      },
    );
  },
);

describe.runIf(POSIX)('commands run one after another in one process', () => {
  it('each take their project where it is when they begin', async () => {
    const world = await mkdtemp(join(await realpath(tmpdir()), 'opm-two-'));
    worlds.push(world);
    // The person's own link, in their home directory: each command fences
    // the tree it runs in below the home directory (`a`, then `b`), and the
    // link to it lies above that.
    vi.stubEnv('HOME', world);
    await mkdir(join(world, 'a'));
    await mkdir(join(world, 'b'));
    const root = join(world, 'project');
    await symlink(join(world, 'a'), root);

    expect(await runOpm(['init', '--name', 'first'], captured().io, root)).toBe(
      0,
    );
    await unlink(root);
    await symlink(join(world, 'b'), root);
    const second = captured();
    expect(
      await runOpm(['init', '--name', 'second'], second.io, root),
      second.seen.err,
    ).toBe(0);
    expect(await readFile(join(world, 'a', 'opm.toml'), 'utf8')).toContain(
      'first',
    );
    expect(await readFile(join(world, 'b', 'opm.toml'), 'utf8')).toContain(
      'second',
    );
  });
});
