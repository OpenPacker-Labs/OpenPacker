/**
 * A path a patch names is held to what the system takes WHOLE (ADR 0057 §13):
 * the directories the host keeps the package in count against the 4,096 bytes
 * of `PATH_MAX`, so a path that passes every bound of its own can still be one
 * the install cannot make. A path of 3,900 bytes below a store directory of 210
 * was `ENAMETOOLONG` from an `lstat`, an internal error (exit 9) naming a store
 * temporary. It is a refusal with the numbers now, at `--plan` (opm-project:
 * `frozen-patch-fit.test.ts`) and at install, here.
 */

import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PatchBudget } from './apply.js';
import { applyPnpmPatch, patchPathBytes } from './index.js';
import { pathOfBytes } from './tree-fixture.js';
import { loadPatchTree } from './tree.js';

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/** A package directory whose path is exactly `bytes` bytes long. */
async function packageOfBytes(bytes: number): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), 'pnpm-patch-whole-'));
  temps.push(base);
  let dir = base;
  while (Buffer.byteLength(dir) < bytes) {
    const room = bytes - Buffer.byteLength(dir) - 1;
    // Segments of 99 bytes; the last is as long as is left (at least one byte).
    dir = join(dir, 'd'.repeat(Math.max(Math.min(room, 99), 1)));
  }
  expect(Buffer.byteLength(dir)).toBe(bytes);
  await mkdir(dir, { recursive: true });
  return dir;
}

const create = (path: string) =>
  [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${path}`,
    '@@ -0,0 +1 @@',
    '+x',
    '',
  ].join('\n');

const patchOf = (text: string) => ({
  key: 'x@1.0.0',
  file: 'patches/x.patch',
  hash: '',
  digest: '',
  text,
});

describe.each([
  ['a short directory', 330],
  ['a directory as long as a store under a deep home', 3_700],
])('a path below %s', (_, directoryBytes) => {
  // The whole path may be 4,095 bytes (4,096 with the NUL).
  const longest = 4_095 - directoryBytes - 1;

  it(`of ${4_095 - directoryBytes - 1} bytes, 4,095 in all, is made`, async () => {
    const dir = await packageOfBytes(directoryBytes);
    const path = pathOfBytes(longest);
    await applyPnpmPatch(dir, patchOf(create(path)), 'x@1.0.0');
    expect(await readFile(join(dir, path), 'utf8')).toBe('x\n');
  });

  it('one byte longer, 4,096 in all, is refused with the numbers and nothing is made', async () => {
    const dir = await packageOfBytes(directoryBytes);
    const path = pathOfBytes(longest + 1);
    const outcome = await applyPnpmPatch(
      dir,
      patchOf(create(path)),
      'x@1.0.0',
    ).then(
      () => 'applied',
      (error: unknown) => error,
    );
    expect(outcome).toMatchObject({
      code: 'UNSAFE_PATH',
      message: expect.stringContaining(
        `is ${longest + 1} bytes long, and below the ${directoryBytes}-byte directory it is made in comes to 4096 bytes, more than the 4095 a system call takes in a path`,
      ),
    });
    expect(String((outcome as Error).message)).not.toMatch(/ENAMETOOLONG/u);
    expect((outcome as Error).message.length).toBeLessThan(700);
    expect(await readdir(dir)).toEqual([]);
  });
});

describe('bytes, not characters', () => {
  /** `bytes` bytes of path in segments of 80 three-byte characters, then `a`s. */
  const multibytePath = (bytes: number): string => {
    const parts: string[] = [];
    let left = bytes;
    while (left > 241) {
      parts.push('日'.repeat(80));
      left -= 241;
    }
    parts.push('a'.repeat(left));
    return parts.join('/');
  };

  it('counts the directory the package is in by its bytes: 1,000 three-byte characters are 3,001', async () => {
    // Nothing is touched before the arithmetic says no, so the directory need not exist.
    const dir = `/${'日'.repeat(1_000)}`;
    expect(Buffer.byteLength(dir)).toBe(3_001);
    expect(dir.length).toBe(1_001);
    const longest = 4_095 - 3_001 - 1;
    const outcome = await applyPnpmPatch(
      dir,
      patchOf(create(pathOfBytes(longest + 1))),
      'x@1.0.0',
    ).then(
      () => 'applied',
      (error: unknown) => error,
    );
    expect(outcome).toMatchObject({
      code: 'UNSAFE_PATH',
      message: expect.stringContaining(
        `is ${longest + 1} bytes long, and below the 3001-byte directory it is made in comes to 4096 bytes`,
      ),
    });
  });

  it('counts a path of three-byte characters by its bytes, in the directory it is made in', async () => {
    const dir = await packageOfBytes(330);
    const longest = 4_095 - 330 - 1;
    const path = multibytePath(longest + 1);
    expect(Buffer.byteLength(path)).toBe(longest + 1);
    expect(path.length).toBeLessThan(longest);
    const outcome = await applyPnpmPatch(
      dir,
      patchOf(create(path)),
      'x@1.0.0',
    ).then(
      () => 'applied',
      (error: unknown) => error,
    );
    expect(outcome).toMatchObject({
      code: 'UNSAFE_PATH',
      message: expect.stringContaining(
        `is ${longest + 1} bytes long, and below the 330-byte directory`,
      ),
    });
    expect(await readdir(dir)).toEqual([]);
  });
});

describe('the longest path of a patch', () => {
  it('is the most bytes a path in any of its effects has, a rename and a deletion included', () => {
    const text = [
      'diff --git a/a b/bbbbbbbb',
      'rename from a',
      'rename to bbbbbbbb',
      'diff --git a/cc b/cc',
      'deleted file mode 100644',
      '',
    ].join('\n');
    expect(patchPathBytes(patchOf(text))).toBe(8);
    expect(patchPathBytes(patchOf(''))).toBe(0);
  });
});

describe('a path the file system itself refuses', () => {
  it('is a refusal naming the path, not a raw ENAMETOOLONG, when reading the tree', async () => {
    const dir = await packageOfBytes(100);
    await mkdir(join(dir, 'lib'));
    // A segment past NAME_MAX never gets here from a patch (`patchPathProblem`
    // refuses it); this is the net under the arithmetic above.
    const effects = [
      {
        type: 'file deletion' as const,
        path: `lib/${'n'.repeat(300)}`,
        mode: 0o644,
        hash: null,
        hunk: null,
      },
    ];
    await expect(
      loadPatchTree(dir, effects, new PatchBudget()),
    ).rejects.toMatchObject({
      name: 'PatchRefusal',
      code: 'UNSAFE_PATH',
      message: expect.stringContaining('longer than the file system takes'),
    });
  });
});
