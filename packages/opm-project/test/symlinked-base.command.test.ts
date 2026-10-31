/**
 * A command against bases that change under it (ADR 0034, amendment of
 * 2026-10-31): the empty `.opm` a step made, removed where it was made after a
 * directory above it was swapped; a TMPDIR retargeted mid-command, refused
 * before anything is published or made; and a lease of a store whose root was
 * retargeted.
 */

import { execFileSync } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { forgetBases } from '@openpacker/project-io';
import {
  enableDefaultSharedStore,
  projectStep,
  usableSharedRoot,
} from '../src/index.js';
import { ensureStableDirectory, writeStableFile } from '../src/paths.js';
import { leaseDirectory, openLease } from '../src/store-lease.js';

const POSIX = process.platform === 'linux' || process.platform === 'darwin';

const worlds: string[] = [];
const mounts: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  enableDefaultSharedStore(false);
  forgetBases();
  for (const mount of mounts.splice(0))
    execFileSync('umount', [mount], { stdio: 'ignore' });
  for (const world of worlds.splice(0))
    await rm(world, { recursive: true, force: true });
});

async function world(): Promise<string> {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'opm-fences-'));
  worlds.push(dir);
  vi.stubEnv('OPM_STORE_HOME', '');
  return dir;
}

describe.runIf(POSIX)('the empty .opm a step made', () => {
  it('is removed in the project it was made in, not where its path leads once a directory above was swapped', async () => {
    const base = await world();
    await mkdir(join(base, 'work', 'proj'), { recursive: true });
    await mkdir(join(base, 'elsewhere', 'proj', '.opm'), { recursive: true });
    const root = join(base, 'work', 'proj');

    await projectStep(root, {}, async () => {
      await rename(join(base, 'work'), join(base, 'work-moved'));
      await symlink(join(base, 'elsewhere'), join(base, 'work'));
    });
    expect(await readdir(join(base, 'elsewhere', 'proj'))).toEqual(['.opm']);
  });
});

describe.runIf(POSIX)('a TMPDIR retargeted while a command runs', () => {
  it('is INPUT_CHANGED before a file is published or a directory made, in either place', async () => {
    const base = await world();
    await mkdir(join(base, 'first'));
    await mkdir(join(base, 'second'));
    await symlink('first', join(base, 'tmp-link'));
    vi.stubEnv('TMPDIR', join(base, 'tmp-link'));
    await ensureStableDirectory(join(tmpdir(), 'one'));

    await unlink(join(base, 'tmp-link'));
    await symlink('second', join(base, 'tmp-link'));
    await expect(
      writeStableFile(join(tmpdir(), 'one', 'file.json'), '{}'),
    ).rejects.toMatchObject({ code: 'INPUT_CHANGED' });
    await expect(
      ensureStableDirectory(join(tmpdir(), 'two')),
    ).rejects.toMatchObject({ code: 'INPUT_CHANGED' });
    expect(await readdir(join(base, 'first'), { recursive: true })).toEqual([
      'one',
    ]);
    expect(await readdir(join(base, 'second'))).toEqual([]);
  });
});

describe.runIf(POSIX)('a lease of a store whose root was retargeted', () => {
  it('is INPUT_CHANGED, and no lease is made where the root leads now', async () => {
    const base = await world();
    await mkdir(join(base, 'a', 'store'), { recursive: true, mode: 0o700 });
    await mkdir(join(base, 'b', 'store'), { recursive: true, mode: 0o700 });
    await chmod(join(base, 'a', 'store'), 0o700);
    await chmod(join(base, 'b', 'store'), 0o700);
    await symlink('a', join(base, 'ln'));
    const store = join(base, 'ln', 'store');
    expect(
      await usableSharedRoot(join(base, 'project'), { OPM_STORE_HOME: store }),
    ).toBe(store);

    await unlink(join(base, 'ln'));
    await symlink('b', join(base, 'ln'));
    await expect(
      openLease(leaseDirectory(store), 'install'),
    ).rejects.toMatchObject({ code: 'INPUT_CHANGED' });
    expect(await readdir(join(base, 'b', 'store'))).toEqual([]);
  });
});
