/**
 * A patch file that grows after it was sized (ADR 0056 §13). Each patch file
 * is sized with the same no-follow open before any is read, and read once
 * sized; a file another process is writing can be larger when it is read than
 * when it was sized. Here the open file reports a size of 10 bytes while it
 * holds more, as one that grew in between would. It is read at most one byte
 * past the bound of one file, so a file that has grown is never held whole;
 * it is held to that bound again, and the files read so far are held to the
 * bound of all of them as they are read.
 */

import { link, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const lie = vi.hoisted(() => ({ size: undefined as number | undefined }));

vi.mock('@openpacker/project-io', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@openpacker/project-io')>();
  const openChild: typeof actual.openChild = async (...args) => {
    const handle = await actual.openChild(...args);
    if (lie.size === undefined) return handle;
    // The size the open file claims; everything else is the file's.
    return new Proxy(handle, {
      get(target, property) {
        if (property === 'stat')
          return async () => ({ isFile: () => true, size: lie.size });
        const value = Reflect.get(target, property) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
  return { ...actual, openChild };
});

const { worldOf } = await import('./frozen-support.js');
const { hashes, patchedLock } = await import('./patch-support.js');
const { PATCH_FILE_LIMITS } = await import('./patch-files.js');

const MiB = 1024 * 1024;
/** Lines a patch reads and ignores, 8,000 characters each, `bytes` of them. */
const junk = (bytes: number) => {
  const line = `${'#'.repeat(8_000)}\n`;
  return line.repeat(Math.floor(bytes / line.length)).padEnd(bytes, '\n');
};

async function declaring(paths: Record<string, string>) {
  const world = await worldOf(patchedLock(hashes().pnpm10), {
    root: { pnpm: { patchedDependencies: paths } },
  });
  return world;
}

describe('a patch file that grew after it was sized', () => {
  it('is refused as SIZE_LIMIT when it is over the bound of one file when read, and read to one byte past it, not whole', async () => {
    const world = await declaring({ 'a@1.0.0': 'patches/a.patch' });
    const where = join(world.project.root, 'patches', 'a.patch');
    await mkdir(dirname(where), { recursive: true });
    // 24 MiB where 10 bytes were sized: more than one file may be.
    await writeFile(where, junk(PATCH_FILE_LIMITS.file + 8 * MiB));
    lie.size = 10;
    try {
      await expect(world.read()).rejects.toMatchObject({
        code: 'SIZE_LIMIT',
        message: expect.stringContaining(
          `the patch file "patches/a.patch" is at least ${PATCH_FILE_LIMITS.file + 1} bytes, more than the ${PATCH_FILE_LIMITS.file} opm reads of one patch file`,
        ),
      });
    } finally {
      lie.size = undefined;
    }
  }, 60_000);

  it('is refused as SIZE_LIMIT when the files read come to more than the bound of all of them', async () => {
    const names = ['a', 'b', 'c', 'd', 'e'].map(
      (name) => `patches/${name}.patch`,
    );
    const world = await declaring(
      Object.fromEntries(
        names.map((path, index) => [`${'abcde'[index]}@1.0.0`, path]),
      ),
    );
    const first = join(world.project.root, names[0]!);
    await mkdir(dirname(first), { recursive: true });
    // Five names for one file of exactly 16 MiB, which is not too large; the
    // fifth read takes the files past 64 MiB. Each reads as a patch with no
    // effect, so only the total can refuse.
    await writeFile(first, junk(PATCH_FILE_LIMITS.file));
    for (const path of names.slice(1))
      await link(first, join(world.project.root, path));
    lie.size = 10;
    try {
      await expect(world.read()).rejects.toMatchObject({
        code: 'SIZE_LIMIT',
        message: expect.stringContaining(
          `the 5 patch files the project declares come to ${5 * PATCH_FILE_LIMITS.file} bytes, more than the ${PATCH_FILE_LIMITS.total}`,
        ),
      });
    } finally {
      lie.size = undefined;
    }
  }, 120_000);
});
