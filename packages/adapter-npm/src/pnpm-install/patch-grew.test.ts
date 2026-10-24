/**
 * A patch file that grows after it was sized (ADR 0057 §13). Each patch file
 * is sized with a no-follow open before any is read, and read once sized; a
 * file another process is writing can be larger when it is read than when it
 * was sized. It is read to at most one byte past the bound of one file, so a
 * file that has grown is never held whole; it is held to that bound again; and
 * the files read are held to the bound of all of them as they are read.
 */

import { link, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PATCH_FILE_LIMITS,
  readPatchBytes,
  readProjectPatches,
} from './patch-files.js';
import { worldOf } from './frozen-support.js';
import { hashes, patchedLock } from './patch-support.js';

const MiB = 1024 * 1024;

/** An open file of `size` bytes of `x` that serves no more than `read` says it did. */
function openFile(size: number) {
  let served = 0;
  return {
    served: () => served,
    async read(buffer: Buffer, offset: number, length: number) {
      const bytesRead = Math.max(Math.min(length, size - served), 0);
      buffer.fill('x', offset, offset + bytesRead);
      served += bytesRead;
      return { bytesRead, buffer };
    },
  };
}

/** Lines a patch reads and ignores, 8,000 characters each, `bytes` of them. */
const junk = (bytes: number) => {
  const line = `${'#'.repeat(8_000)}\n`;
  return line.repeat(Math.floor(bytes / line.length)).padEnd(bytes, '\n');
};

describe('a patch file open at the moment it is read', () => {
  it('is read to one byte past the bound of one file and refused there, not held whole', async () => {
    // 24 MiB where less was sized: more than one file may be.
    const file = openFile(PATCH_FILE_LIMITS.file + 8 * MiB);
    const outcome = await readPatchBytes(file, 'patches/a.patch').then(
      (bytes) => `read ${bytes.length} bytes`,
      (error: unknown) => error,
    );
    expect(outcome).toMatchObject({
      code: 'SIZE_LIMIT',
      message: expect.stringContaining(
        `the patch file "patches/a.patch" is at least ${PATCH_FILE_LIMITS.file + 1} bytes, more than the ${PATCH_FILE_LIMITS.file} opm reads of one patch file`,
      ),
    });
    expect(file.served()).toBe(PATCH_FILE_LIMITS.file + 1);
  });

  it('is taken at the bound itself', async () => {
    const bytes = await readPatchBytes(
      openFile(PATCH_FILE_LIMITS.file),
      'patches/a.patch',
    );
    expect(bytes.length).toBe(PATCH_FILE_LIMITS.file);
  });
});

describe('the patch files of a lock that grew after they were sized', () => {
  it('are refused as SIZE_LIMIT once the files read come to more than the bound of all of them', async () => {
    const names = ['a', 'b', 'c', 'd', 'e'];
    const paths = names.map((name) => `patches/${name}.patch`);
    const world = await worldOf(patchedLock(hashes().pnpm10), {});
    const root = world.project.root;
    const first = join(root, paths[0]!);
    await mkdir(dirname(first), { recursive: true });
    // Five names for one file, empty when sized: nothing is over any bound.
    await writeFile(first, '');
    for (const path of paths.slice(1)) await link(first, join(root, path));
    const config = {
      patches: new Map(names.map((name, i) => [`${name}@1.0.0`, paths[i]!])),
      patchesFrom: 'package.json pnpm.patchedDependencies' as const,
    };
    const lock = { patchedDependencies: new Map() };
    // Then it grows to exactly 16 MiB, which is not too large for one file;
    // the fifth read takes the files past 64 MiB. Each reads as a patch with
    // no effect, so only the total can refuse.
    const grow = () => writeFile(first, junk(PATCH_FILE_LIMITS.file));
    await expect(
      readProjectPatches(root, config, lock, grow),
    ).rejects.toMatchObject({
      code: 'SIZE_LIMIT',
      message: expect.stringContaining(
        `the 5 patch files the project declares come to ${5 * PATCH_FILE_LIMITS.file} bytes, more than the ${PATCH_FILE_LIMITS.total}`,
      ),
    });
  }, 120_000);
});
