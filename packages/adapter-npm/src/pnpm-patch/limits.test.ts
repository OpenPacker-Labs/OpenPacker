/**
 * The bounds a patch is held to (ADR 0057 §13): the paths it names meet the
 * bounds of a path in an archive, 128 segments and 4,096 UTF-8 bytes, and it
 * names at most the 100,000 files a package's archive may hold. pnpm has none
 * of them; a path past them is refused when the patch is read, so `opm ci
 * --plan` refuses it before anything is fetched. A path much past them
 * makes a header line past `MAXIMUM_HEADER_LINE`, and that is the bound that
 * refuses it (`header-limits.test.ts`).
 */

import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PATCH_WORK_BUDGET } from './apply.js';
import { applyPnpmPatch, readPatchText } from './index.js';
import { pathOfBytes } from './tree-fixture.js';
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
      refusal('SIZE_LIMIT', 'characters, more than the 8300'),
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
    ).rejects.toMatchObject({ code: 'SIZE_LIMIT' });
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(process.memoryUsage().heapUsed - heap).toBeLessThan(64 << 20);
    expect(await readdir(dir)).toEqual(['package.json']);
  });

  it('refuses a path 2,000 segments deep, which a header line takes, as a path', () => {
    expect(() => readPatchText(create(deep(2_000)), 'p')).toThrow(
      refusal('UNSAFE_PATH', 'is 2001 segments deep, more than the 127'),
    );
  });

  it('takes a path 127 segments deep and refuses one 128 deep: the archive counts package/ as the 128th', () => {
    expect(readPatchText(create(deep(126)), 'p')).toHaveLength(1);
    expect(() => readPatchText(create(deep(127)), 'p')).toThrow(
      refusal('UNSAFE_PATH', 'is 128 segments deep, more than the 127'),
    );
  });

  it('takes a path of 4,096 UTF-8 bytes and refuses one of 4,097, counting bytes and not characters', () => {
    // 4,096 bytes with the package/ the archive counts in front of it.
    expect(pathOfBytes(4_088)).toHaveLength(4_088);
    expect(readPatchText(create(pathOfBytes(4_088)), 'p')).toHaveLength(1);
    expect(() => readPatchText(create(pathOfBytes(4_089)), 'p')).toThrow(
      refusal('UNSAFE_PATH', 'is 4089 bytes long, more than the 4088'),
    );
    // Two bytes each: 4,090 bytes in about 2,000 characters and separators.
    const accented = pathOfBytes(4_090, 'é');
    expect(Buffer.byteLength(accented)).toBe(4_090);
    expect(accented.length).toBeLessThan(4_090 - 1_000);
    expect(() => readPatchText(create(accented), 'p')).toThrow(
      refusal('UNSAFE_PATH', 'is 4090 bytes long'),
    );
  });

  it('shows a refused path cut short, not whole', () => {
    // A rename line holds one path, so one of 8,000 characters is under the
    // header line bound and over the path bound.
    const text = `diff --git a/x b/y\nrename from ${'d'.repeat(8_000)}\nrename to y\n`;
    expect(() => readPatchText(text, 'p')).toThrow(
      expect.objectContaining({
        code: 'UNSAFE_PATH',
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

describe('the work a patch may do', () => {
  const patchOf = (text: string) => ({
    key: 'x@1.0.0',
    file: 'p.patch',
    hash: '',
    digest: '',
    text,
  });

  async function packageWith(name: string, text: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'pnpm-patch-work-'));
    temps.push(dir);
    await writeFile(join(dir, name), text);
    return dir;
  }

  it('is 256 MiB of characters read, compared and written', () => {
    expect(PATCH_WORK_BUDGET).toBe(256 * 1024 * 1024);
  });

  it('refuses, as too costly, the 146 KB patch of 2,000 sections that each change one line of one 2 MB file', async () => {
    const body = `A\n${Array.from({ length: 50_000 }, (_, index) => `line ${index} ${'x'.repeat(30)}`).join('\n')}\n`;
    const sections: string[] = [];
    for (let index = 0; index < 2_000; index += 1) {
      const [from, to] = index % 2 === 0 ? ['A', 'B'] : ['B', 'A'];
      sections.push(
        'diff --git a/big.js b/big.js',
        '--- a/big.js',
        '+++ b/big.js',
        '@@ -1 +1 @@',
        `-${from}`,
        `+${to}`,
      );
    }
    const text = `${sections.join('\n')}\n`;
    expect(Buffer.byteLength(text)).toBe(146_000);
    const dir = await packageWith('big.js', body);
    const started = performance.now();
    await expect(
      applyPnpmPatch(dir, patchOf(text), 'x@1.0.0'),
    ).rejects.toMatchObject({
      code: 'PATCH_FAILED',
      message: expect.stringContaining(
        'it is too costly to apply: it would read, compare and write more than 268435456 characters',
      ),
    });
    expect(performance.now() - started).toBeLessThan(20_000);
    expect(await readFile(join(dir, 'big.js'), 'utf8')).toBe(body);
  }, 120_000);

  it('compares a line of 80,000 spaces in one pass, ignoring its trailing whitespace as pnpm does', async () => {
    const wide = `${' '.repeat(80_000)}x`;
    const dir = await packageWith('wide.js', `${wide}  \nold\n`);
    const text = [
      'diff --git a/wide.js b/wide.js',
      '--- a/wide.js',
      '+++ b/wide.js',
      '@@ -1,2 +1,2 @@',
      ` ${wide}`,
      '-old',
      '+new',
      '',
    ].join('\n');
    const started = performance.now();
    await applyPnpmPatch(dir, patchOf(text), 'x@1.0.0');
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(await readFile(join(dir, 'wide.js'), 'utf8')).toBe(
      `${wide}  \nnew\n`,
    );
  }, 120_000);
});
