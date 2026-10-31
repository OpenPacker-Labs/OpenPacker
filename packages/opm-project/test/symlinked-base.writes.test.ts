/**
 * The writes and removals that reach a project or a store by path once its
 * base is taken, each with a link swapped in where it acts: the store's
 * removal of a half-linked entry, the rollback copy's discard and its putting
 * back, the owner file, the tool cache, the auth config. Each is refused and
 * leaves what the link points at as it was (ADR 0034, amendment of
 * 2026-10-31).
 */

import { createHash } from 'node:crypto';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { forgetBases, packTarGzip } from '@openpacker/project-io';
import {
  fetchTool,
  initProject,
  materializeThroughSharedStore,
  projectPaths,
  snapshotProject,
  storeKeyFromDigest,
  upsertAuthOrigin,
  writeOwnerFile,
} from '../src/index.js';

const POSIX = process.platform === 'linux' || process.platform === 'darwin';

const worlds: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  forgetBases();
  for (const world of worlds.splice(0))
    await rm(world, { recursive: true, force: true });
});

async function world(): Promise<string> {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'opm-swapped-'));
  worlds.push(dir);
  vi.stubEnv('OPM_STORE_HOME', '');
  return dir;
}

/** Replace the directory `path` by a link to `target`, keeping what it held at `<path>.moved`. */
async function swapForLink(path: string, target: string): Promise<void> {
  await rename(path, `${path}.moved`);
  await symlink(target, path);
}

describe.runIf(POSIX)('a link swapped in where opm writes by path', () => {
  it('is refused where a half-linked store entry is removed, and the entry it points at stays', async () => {
    const base = await world();
    const shared = join(base, 'shared');
    await mkdir(shared, { mode: 0o700 });
    const root = join(base, 'project');
    await mkdir(join(root, '.opm', 'store'), { recursive: true });
    projectPaths(root);
    const bytes = packTarGzip([
      {
        path: 'package/index.js',
        contents: new TextEncoder().encode('export const n = 1;\n'),
      },
    ]);
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    const key = storeKeyFromDigest(digest);
    const outside = join(base, 'outside');
    await mkdir(join(outside, key), { recursive: true });
    await writeFile(join(outside, key, 'keep.txt'), 'not opm’s');

    await expect(
      materializeThroughSharedStore({
        digest,
        projectStorePath: join(root, '.opm', 'store', key),
        bytes,
        format: 'tar+gzip',
        env: { OPM_STORE_HOME: shared },
        linkFile: async () => {
          await swapForLink(join(root, '.opm', 'store'), outside);
          throw Object.assign(new Error('the disk went away'), { code: 'EIO' });
        },
      }),
    ).rejects.toMatchObject({ code: 'EIO' });
    expect(await readFile(join(outside, key, 'keep.txt'), 'utf8')).toBe(
      'not opm’s',
    );
  });

  it('is refused where a step discards its copy, and the directory it points at stays whole', async () => {
    const base = await world();
    const root = join(base, 'project');
    await mkdir(root);
    await initProject({ root, name: 'swapped' });
    const snapshot = await snapshotProject(root);
    const holder = (await readdir(join(root, '.opm'))).find((name) =>
      name.startsWith('.rollback-'),
    )!;
    const outside = join(base, 'outside');
    await mkdir(join(outside, holder), { recursive: true });
    await writeFile(join(outside, holder, 'keep.txt'), 'not opm’s');
    await swapForLink(join(root, '.opm'), outside);

    await expect(snapshot.discard()).rejects.toMatchObject({
      code: 'UNSAFE_PATH',
    });
    expect(await readdir(outside)).toEqual([holder]);
    expect(await readFile(join(outside, holder, 'keep.txt'), 'utf8')).toBe(
      'not opm’s',
    );
  });

  it('is refused where a step puts its copy back, and the copy it points at stays whole', async () => {
    const base = await world();
    const root = join(base, 'project');
    await mkdir(join(root, 'node_modules'), { recursive: true });
    await writeFile(join(root, 'node_modules', 'kept.txt'), 'before');
    await initProject({ root, name: 'swapped' });
    const snapshot = await snapshotProject(root);
    // What the link points at is a copy of `.opm`, rollback copy and all: a
    // putting back that followed the link would move it into the project.
    const outside = join(base, 'outside');
    await cp(join(root, '.opm'), outside, {
      recursive: true,
      verbatimSymlinks: true,
    });
    await swapForLink(join(root, '.opm'), outside);
    const before = (await readdir(outside, { recursive: true })).sort();

    await expect(snapshot.restore()).rejects.toMatchObject({
      code: 'UNSAFE_PATH',
    });
    expect((await readdir(outside, { recursive: true })).sort()).toEqual(
      before,
    );
  });

  it('is refused where a tool cache named inside a project is made, and nothing is made where it points', async () => {
    const base = await world();
    const root = join(base, 'project');
    const outside = join(base, 'outside');
    await mkdir(root);
    await mkdir(outside);
    await symlink(outside, join(root, 'tools'));
    projectPaths(root);

    await expect(
      fetchTool({
        purl: 'pkg:npm/left-pad@1.3.0',
        cacheRoot: join(root, 'tools', 'x'),
        registryOptions: {
          fetch: () => Promise.reject(new Error('no registry in this test')),
        },
      }),
    ).rejects.toMatchObject({
      code: expect.stringMatching(/^(ENOTDIR|ELOOP|UNSAFE_PATH)$/u),
    });
    expect(await readdir(outside)).toEqual([]);
  });

  it('is refused where an owner file is written, and nothing is written where it points', async () => {
    const base = await world();
    const outside = join(base, 'outside');
    await mkdir(join(outside, 'run'), { recursive: true });
    await symlink(outside, join(base, 'swapped'));

    await expect(
      writeOwnerFile(join(base, 'swapped', 'run')),
    ).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    expect(await readdir(join(outside, 'run'))).toEqual([]);
  });

  it('is refused where the auth config is written inside a project that holds a link there', async () => {
    const base = await world();
    const root = join(base, 'project');
    const outside = join(base, 'outside');
    await mkdir(root);
    await mkdir(outside);
    await symlink(outside, join(root, '.config'));
    projectPaths(root);

    await expect(
      upsertAuthOrigin({
        origin: 'https://registry.example.test',
        env: { XDG_CONFIG_HOME: join(root, '.config') },
      }),
    ).rejects.toMatchObject({
      code: expect.stringMatching(/^(ENOTDIR|ELOOP|UNSAFE_PATH)$/u),
    });
    expect(await readdir(outside, { recursive: true })).toEqual([]);
  });
});
