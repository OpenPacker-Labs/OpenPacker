/**
 * The bounds a patch is held to (ADR 0056 §13): the paths it names meet the
 * bounds of a path in an archive, 128 segments and 4,096 UTF-8 bytes, and it
 * names at most the 100,000 files a package's archive may hold. pnpm has none
 * of them; a path past them is refused when the patch is read, so `opm ci
 * --plan` refuses it before anything is fetched.
 */

import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyPnpmPatch, readPatchText } from './index.js';
import { withAncestors } from './tree.js';

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

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

/** `segments` directories of one letter, then `f.js`. */
const deep = (segments: number) => `${'a/'.repeat(segments)}f.js`;

const refusal = (code: string, words: string) =>
  expect.objectContaining({
    code,
    message: expect.stringContaining(words),
  });

describe('the bounds of a patch', () => {
  it('refuses the 40,000-segment path at once and in bounded memory, before a directory is looked at', async () => {
    const text = create(deep(40_000));
    let started = performance.now();
    expect(() => readPatchText(text, 'p.patch')).toThrow(
      refusal('UNSAFE_PATH', 'bytes long'),
    );
    expect(performance.now() - started).toBeLessThan(1_000);

    const dir = await mkdtemp(join(tmpdir(), 'pnpm-patch-limits-'));
    temps.push(dir);
    await writeFile(join(dir, 'package.json'), '{}');
    const heap = process.memoryUsage().heapUsed;
    started = performance.now();
    await expect(
      applyPnpmPatch(
        dir,
        { key: 'a@1.0.0', file: 'p.patch', hash: '', digest: '', text },
        'a@1.0.0',
      ),
    ).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(process.memoryUsage().heapUsed - heap).toBeLessThan(64 << 20);
    expect(await readdir(dir)).toEqual(['package.json']);
  });

  it('takes a path 128 segments deep and refuses one 129 deep, as an archive', () => {
    expect(readPatchText(create(deep(127)), 'p')).toHaveLength(1);
    expect(() => readPatchText(create(deep(128)), 'p')).toThrow(
      refusal('UNSAFE_PATH', 'is 129 segments deep, more than the 128'),
    );
  });

  it('takes a path of 4,096 UTF-8 bytes and refuses one of 4,097, counting bytes and not characters', () => {
    expect(readPatchText(create('a'.repeat(4_096)), 'p')).toHaveLength(1);
    expect(() => readPatchText(create('a'.repeat(4_097)), 'p')).toThrow(
      refusal('UNSAFE_PATH', 'is 4097 bytes long, more than the 4096'),
    );
    // 2,049 characters, two bytes each.
    expect(() => readPatchText(create('é'.repeat(2_049)), 'p')).toThrow(
      refusal('UNSAFE_PATH', 'is 4098 bytes long'),
    );
  });

  it('shows a refused path cut short, not whole', () => {
    expect(() => readPatchText(create(deep(40_000)), 'p')).toThrow(
      expect.objectContaining({
        message: expect.stringMatching(/^.{1,400}$/su),
      }),
    );
  });

  it('takes a patch that names 100,000 files and refuses one that names 100,001 (SIZE_LIMIT)', () => {
    const sections = (count: number) =>
      Array.from(
        { length: count },
        (_, index) =>
          `diff --git a/f${index} b/f${index}\nnew file mode 100644\n`,
      ).join('');
    expect(readPatchText(sections(100_000), 'p')).toHaveLength(100_000);
    expect(() => readPatchText(sections(100_001), 'p')).toThrow(
      refusal('SIZE_LIMIT', 'names 100001 paths, more than the 100000 files'),
    );
  }, 60_000);

  it('lists every directory above the paths once, shortest first, in one pass over each', () => {
    expect(withAncestors(['b/c/d.js', 'a.js', 'b/e.js', 'b/c/f.js'])).toEqual([
      'b',
      'a.js',
      'b/c',
      'b/e.js',
      'b/c/d.js',
      'b/c/f.js',
    ]);
    // 2,000 paths at the bounds, 127 directories and 4,095 bytes each.
    const paths = Array.from(
      { length: 2_000 },
      (_, index) => `${'d/'.repeat(127)}${String(index).padStart(3_841, 'x')}`,
    );
    const started = performance.now();
    expect(withAncestors(paths)).toHaveLength(127 + 2_000);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
