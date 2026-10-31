import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

describe.runIf(POSIX)('commands run one after another in one process', () => {
  it('each take their project where it is when they begin', async () => {
    const world = await mkdtemp(join(await realpath(tmpdir()), 'opm-two-'));
    worlds.push(world);
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
