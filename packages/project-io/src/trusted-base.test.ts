/**
 * A path whose base runs through a symbolic link: `TMPDIR`, `HOME` or an XDG
 * directory behind a link, macOS's `/var` → `/private/var`, a project reached
 * through a linked directory. The walk takes the links on the way to its base
 * and refuses every link below it.
 *
 * Each case builds its own world in a real directory and points the
 * environment into it, so nothing here depends on how the machine's own
 * `TMPDIR` is laid out.
 */

import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BASE_VARIABLES,
  collectFiles,
  forgetBases,
  materialiseTree,
  openStableDirectory,
  stableTarget,
  trustBase,
  writeFileAtomic,
} from './index.js';
import { openProjectDirectory } from './stable-open.js';

const POSIX = process.platform === 'linux' || process.platform === 'darwin';

const worlds: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  forgetBases();
  for (const world of worlds.splice(0))
    await rm(world, { recursive: true, force: true });
});

/** A real, empty directory to build a world in. */
async function world(): Promise<string> {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'trusted-base-'));
  worlds.push(dir);
  return dir;
}

/** `<world>/<real>` as a directory and `<world>/<link>` → it. */
async function linked(
  base: string,
  real: string,
  link: string,
): Promise<{ real: string; link: string }> {
  await mkdir(join(base, real), { recursive: true });
  await symlink(real, join(base, link), 'dir');
  return { real: join(base, real), link: join(base, link) };
}

async function writesThrough(
  directory: string,
  expectedReal: string,
): Promise<void> {
  await writeFileAtomic(join(directory, 'package.json'), '{"name":"p"}\n');
  expect(await readFile(join(expectedReal, 'package.json'), 'utf8')).toBe(
    '{"name":"p"}\n',
  );
  const handle = await openStableDirectory(join(directory, 'node_modules'));
  await handle.close();
  expect((await lstat(join(expectedReal, 'node_modules'))).isDirectory()).toBe(
    true,
  );
}

describe.runIf(POSIX)('a base reached through a link', () => {
  it('writes under a TMPDIR that is a link', async () => {
    const base = await world();
    const tmp = await linked(base, 'real-tmp', 'tmp-link');
    vi.stubEnv('TMPDIR', tmp.link);
    expect(tmpdir()).toBe(tmp.link);

    const scratch = await mkdtemp(join(tmpdir(), 'opm-bins-'));
    await writesThrough(scratch, join(tmp.real, scratch.split('/').at(-1)!));
  });

  it('writes under TMPDIR the way macOS lays it out: /var → /private/var', async () => {
    const base = await world();
    await mkdir(join(base, 'private', 'var', 'folders', 'xy', 'T'), {
      recursive: true,
    });
    await symlink('private/var', join(base, 'var'), 'dir');
    const lexical = join(base, 'var', 'folders', 'xy', 'T');
    vi.stubEnv('TMPDIR', lexical);

    const project = join(tmpdir(), 'project');
    await mkdir(project);
    await writesThrough(
      project,
      join(base, 'private/var/folders/xy/T/project'),
    );
    expect(stableTarget(join(project, 'a'))).toBe(
      join(base, 'private/var/folders/xy/T/project/a'),
    );
  });

  it('writes under HOME and the XDG directories when each is behind a link', async () => {
    const base = await world();
    const home = await linked(base, 'home-real', 'home-link');
    const cache = await linked(base, 'cache-real', 'cache-link');
    vi.stubEnv('HOME', home.link);
    vi.stubEnv('XDG_CACHE_HOME', cache.link);

    await writesThrough(
      join(home.link, '.local', 'share', 'openpacker', 'plugins'),
      join(home.real, '.local', 'share', 'openpacker', 'plugins'),
    );
    await writesThrough(
      join(cache.link, 'openpacker', 'store'),
      join(cache.real, 'openpacker', 'store'),
    );
  });

  it('writes in a project reached through a linked parent once its root is taken', async () => {
    const base = await world();
    const parent = await linked(base, 'code-real', 'code');
    await mkdir(join(parent.real, 'project'));
    const root = join(parent.link, 'project');

    expect(trustBase(root, 'project root')).toBe(join(parent.real, 'project'));
    await writesThrough(root, join(parent.real, 'project'));
  });

  it('writes in a project root that is itself a link once it is taken, as npm, pnpm and git do', async () => {
    const base = await world();
    const project = await linked(base, 'checkout', 'project');

    trustBase(project.link, 'project root');
    await writesThrough(project.link, project.real);
    const files = await collectFiles(project.link);
    expect(files.map((file) => file.path)).toEqual(['package.json']);
  });

  it('lays a tree out in a project reached through a link', async () => {
    const base = await world();
    const parent = await linked(base, 'code-real', 'code');
    const root = join(parent.link, 'project');
    await mkdir(join(parent.real, 'project', 'store', 'entry'), {
      recursive: true,
    });
    await writeFile(join(parent.real, 'project', 'store', 'entry', 'a'), 'a');
    trustBase(root, 'project root');

    await materialiseTree(
      join(root, 'store', 'entry'),
      join(root, 'node_modules', 'pkg'),
      root,
    );
    expect(
      await readFile(join(parent.real, 'project/node_modules/pkg/a'), 'utf8'),
    ).toBe('a');
  });
});

describe.runIf(POSIX)('a link below a base', () => {
  it('is refused under a taken project root, and nothing is made where it points', async () => {
    const base = await world();
    const parent = await linked(base, 'code-real', 'code');
    const root = join(parent.link, 'project');
    await mkdir(join(parent.real, 'project'));
    await mkdir(join(base, 'outside'));
    await symlink(join(base, 'outside'), join(parent.real, 'project', '.opm'));
    trustBase(root, 'project root');

    await expect(
      openStableDirectory(join(root, '.opm', 'store')),
    ).rejects.toMatchObject({
      code: expect.stringMatching(/^(ENOTDIR|ELOOP)$/u),
    });
    await expect(
      writeFileAtomic(join(root, '.opm', 'project.json'), '{}'),
    ).rejects.toMatchObject({
      code: expect.stringMatching(/^(ENOTDIR|ELOOP)$/u),
    });
    await expect(
      openProjectDirectory(join(root, '.opm', 'store'), true),
    ).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    expect(await readdir(join(base, 'outside'))).toEqual([]);
  });

  it('is refused under a TMPDIR that is a link', async () => {
    const base = await world();
    const tmp = await linked(base, 'real-tmp', 'tmp-link');
    vi.stubEnv('TMPDIR', tmp.link);
    await mkdir(join(base, 'elsewhere'));
    await symlink(join(base, 'elsewhere'), join(tmp.real, 'swapped'));

    await expect(
      openStableDirectory(join(tmpdir(), 'swapped', 'x')),
    ).rejects.toMatchObject({
      code: expect.stringMatching(/^(ENOTDIR|ELOOP)$/u),
    });
    await expect(
      openProjectDirectory(join(tmpdir(), 'swapped', 'x'), true),
    ).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    expect(await readdir(join(base, 'elsewhere'))).toEqual([]);
  });

  it('is refused when it was swapped in after the root was taken', async () => {
    const base = await world();
    const root = join(base, 'project');
    await mkdir(join(root, 'node_modules'), { recursive: true });
    trustBase(root, 'project root');
    const held = await openStableDirectory(join(root, 'node_modules'));
    await held.close();

    await mkdir(join(base, 'outside'));
    await rm(join(root, 'node_modules'), { recursive: true });
    await symlink(join(base, 'outside'), join(root, 'node_modules'));
    await expect(
      openProjectDirectory(join(root, 'node_modules', 'pkg'), true),
    ).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    await expect(
      writeFileAtomic(join(root, 'node_modules', 'pkg.json'), '{}'),
    ).rejects.toMatchObject({
      code: expect.stringMatching(/^(ENOTDIR|ELOOP)$/u),
    });
    expect(await readdir(join(base, 'outside'))).toEqual([]);
  });

  it('is refused on the way to a path that lies under no base', async () => {
    const base = await world();
    const alias = await linked(base, 'real', 'alias');
    vi.stubEnv('TMPDIR', join(base, 'unrelated'));
    vi.stubEnv('HOME', join(base, 'unrelated-home'));
    for (const name of BASE_VARIABLES) vi.stubEnv(name, '');

    await expect(
      openProjectDirectory(join(alias.link, 'sub'), true),
    ).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    expect(await readdir(alias.real)).toEqual([]);
  });
});

/** A project at `<base>/project` that holds `.cache -> <base>/outside`. */
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

describe.runIf(POSIX)('an environment base inside a taken project', () => {
  it('is resolved no further than the project, so the link the project holds is refused', async () => {
    const base = await world();
    const { root, outside } = await projectHoldingLink(base);
    vi.stubEnv('XDG_CACHE_HOME', join(root, '.cache'));
    trustBase(root, 'project root');

    await expect(
      openStableDirectory(join(root, '.cache', 'pio')),
    ).rejects.toMatchObject({
      code: expect.stringMatching(/^(ENOTDIR|ELOOP)$/u),
    });
    await expect(
      openProjectDirectory(join(root, '.cache', 'layout'), true),
    ).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    expect(await readdir(outside)).toEqual([]);
  });

  it('is no base once the project is taken, though it was resolved through the link before', async () => {
    const base = await world();
    const { root, outside } = await projectHoldingLink(base);
    vi.stubEnv('XDG_CACHE_HOME', join(root, '.cache'));
    expect(stableTarget(join(root, '.cache', 'x'))).toBe(join(outside, 'x'));
    trustBase(root, 'project root');

    expect(stableTarget(join(root, '.cache', 'x'))).toBe(
      join(base, 'project', '.cache', 'x'),
    );
    await expect(
      openStableDirectory(join(root, '.cache', 'x')),
    ).rejects.toMatchObject({
      code: expect.stringMatching(/^(ENOTDIR|ELOOP)$/u),
    });
    expect(await readdir(outside)).toEqual([]);
  });

  it('is refused below the link too, and when spelled through the real path of a project taken through a link', async () => {
    const base = await world();
    const code = await linked(base, 'code-real', 'code');
    const real = join(code.real, 'project');
    await mkdir(real);
    await mkdir(join(base, 'outside'));
    await symlink(join(base, 'outside'), join(real, '.cache'));
    trustBase(join(code.link, 'project'), 'project root');

    vi.stubEnv('XDG_CACHE_HOME', join(real, '.cache', 'deeper'));
    await expect(
      openStableDirectory(join(real, '.cache', 'deeper', 'x')),
    ).rejects.toMatchObject({
      code: expect.stringMatching(/^(ENOTDIR|ELOOP)$/u),
    });
    expect(await readdir(join(base, 'outside'))).toEqual([]);
  });
});

describe.runIf(POSIX)('a base in the course of one command', () => {
  it('is INPUT_CHANGED when it is taken again and leads somewhere else, and its first real path is kept', async () => {
    const base = await world();
    await mkdir(join(base, 'a'));
    await mkdir(join(base, 'b'));
    const root = join(base, 'project');
    await symlink(join(base, 'a'), root);
    trustBase(root, 'project root');
    (await openStableDirectory(join(root, 'one'))).close();

    await unlink(root);
    await symlink(join(base, 'b'), root);
    (await openStableDirectory(join(root, 'two'))).close();
    expect(() => trustBase(root, 'project root')).toThrow(
      expect.objectContaining({ code: 'INPUT_CHANGED' }),
    );
    expect(await readdir(join(base, 'a'))).toEqual(['one', 'two']);
    expect(await readdir(join(base, 'b'))).toEqual([]);
  });

  it('is resolved once from the environment, so a TMPDIR link retargeted later splits nothing', async () => {
    const base = await world();
    const tmp = await linked(base, 'first', 'tmp-link');
    await mkdir(join(base, 'second'));
    vi.stubEnv('TMPDIR', tmp.link);
    (await openStableDirectory(join(tmpdir(), 'one'))).close();

    await unlink(tmp.link);
    await symlink('second', tmp.link);
    (await openStableDirectory(join(tmpdir(), 'two'))).close();
    expect(await readdir(tmp.real)).toEqual(['one', 'two']);
    expect(await readdir(join(base, 'second'))).toEqual([]);
  });

  it('is forgotten when the command ends: what one command took is no base for the next', async () => {
    const base = await world();
    const alias = await linked(base, 'real', 'alias');
    for (const name of BASE_VARIABLES) vi.stubEnv(name, '');
    trustBase(alias.link, 'project root');
    (await openStableDirectory(join(alias.link, 'first'))).close();

    forgetBases();
    await expect(
      openStableDirectory(join(alias.link, 'second')),
    ).rejects.toMatchObject({
      code: expect.stringMatching(/^(ENOTDIR|ELOOP)$/u),
    });
    expect(await readdir(alias.real)).toEqual(['first']);
  });
});
