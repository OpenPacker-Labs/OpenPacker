/**
 * The bounds on the patch files a lock declares (ADR 0056 §13): each is at
 * most 16 MiB, and together at most 64 MiB, each read whole into memory as
 * bytes and as text when the lock is read. Past either, the lock is refused
 * as SIZE_LIMIT before any patch is read; pnpm reads whatever is there. The
 * files here are sparse: they take no disk.
 */

import { mkdir, truncate, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { worldOf } from './frozen-support.js';
import { hashes, patchedLock } from './patch-support.js';
import { PATCH_FILE_LIMITS } from './patch-files.js';

const MiB = 1024 * 1024;

/** A file of `content`, or a sparse one of that many bytes. */
async function sized(root: string, path: string, content: number | string) {
  const where = join(root, ...path.split('/'));
  await mkdir(dirname(where), { recursive: true });
  await writeFile(where, typeof content === 'string' ? content : '');
  if (typeof content === 'number') await truncate(where, content);
}

async function declaring(files: Record<string, number | string>) {
  const paths = Object.fromEntries(
    Object.keys(files).map((key, index) => [key, `patches/${index}.patch`]),
  );
  const world = await worldOf(patchedLock(hashes().pnpm10), {
    root: { pnpm: { patchedDependencies: paths } },
  });
  for (const [key, bytes] of Object.entries(files))
    await sized(world.project.root, paths[key]!, bytes);
  return world;
}

describe('the size of the patch files a lock declares', () => {
  it('is at most 16 MiB a file and 64 MiB in all', () => {
    expect(PATCH_FILE_LIMITS).toEqual({ file: 16 * MiB, total: 64 * MiB });
  });

  it('refuses a patch file of 16 MiB and a byte as SIZE_LIMIT, not as a broken lock', async () => {
    const world = await declaring({ 'a@1.0.0': 16 * MiB + 1 });
    await expect(world.read()).rejects.toMatchObject({
      code: 'SIZE_LIMIT',
      message: expect.stringContaining(
        'the patch file "patches/0.patch" is 16777217 bytes, more than the 16777216 opm reads of one patch file',
      ),
    });
  });

  it('refuses patch files that come to more than 64 MiB, before any is read', async () => {
    // The first file pnpm cannot read: had it been read, the lock would be
    // refused for that (INVALID_PATCH), not for the total.
    const unreadable = 'diff --git a/x b/x\n@@ -1 +1 @@\n\\ bogus pragma\n';
    const world = await declaring({
      'a@1.0.0': unreadable,
      'b@1.0.0': 16 * MiB,
      'c@1.0.0': 16 * MiB,
      'd@1.0.0': 16 * MiB,
      'e@1.0.0': 16 * MiB,
    });
    await expect(world.read()).rejects.toMatchObject({
      code: 'SIZE_LIMIT',
      message: expect.stringContaining(
        `the 5 patch files the project declares come to ${64 * MiB + unreadable.length} bytes, more than the 67108864 opm reads of patches for one lock`,
      ),
    });
  });
});
