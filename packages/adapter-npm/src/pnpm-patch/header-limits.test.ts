/**
 * The header lines of a patch are read in linear time and held to a bound
 * (ADR 0056 §13). pnpm reads `index ` and `diff --git` lines with two regexes
 * that backtrack: one header line of 40,000 characters took 5.8 s, 160,000
 * took 104 s, and the patch file may be 16 MiB, so `opm ci --plan` could be
 * held for days before it had a budget to spend. opm refuses a header line
 * longer than two paths at the bounds of a path in an archive and the frame
 * around them, which no line a git diff writes comes near.
 */

import { describe, expect, it } from 'vitest';
import { INTERPRETED_PREFIXES, MAXIMUM_HEADER_LINE } from './header-lines.js';
import { readPatchText } from './index.js';
import { pathOfBytes } from './tree-fixture.js';

/** A patch whose one header line, between `diff --git` and the hunk, is `line`. */
const withHeader = (line: string) =>
  [
    'diff --git a/f.js b/f.js',
    line,
    '--- a/f.js',
    '+++ b/f.js',
    '@@ -1 +1 @@',
    '-a',
    '+b',
    '',
  ].join('\n');

/** A `diff --git` line followed by `tail`. */
const withDiffLine = (tail: string) =>
  [
    `diff --git a/f.js b/f.js${tail}`,
    '--- a/f.js',
    '+++ b/f.js',
    '@@ -1 +1 @@',
    '-a',
    '+b',
    '',
  ].join('\n');

const tooLong = (length: number) =>
  expect.objectContaining({
    code: 'SIZE_LIMIT',
    message: expect.stringMatching(
      new RegExp(`${length} characters, more than the ${MAXIMUM_HEADER_LINE}`),
    ),
  });

describe('a header line of a patch', () => {
  it('may be 8,300 characters: two paths of 4,088 bytes and the frame around them', () => {
    expect(MAXIMUM_HEADER_LINE).toBe(8_300);
    const path = pathOfBytes(4_088);
    const diffLine = `diff --git a/${path} b/${path}`;
    expect(diffLine.length).toBe(8_192);
    expect(MAXIMUM_HEADER_LINE).toBeGreaterThan(diffLine.length);
    const effects = readPatchText(
      `${diffLine}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-a\n+b\n`,
      'p.patch',
    );
    expect(effects).toHaveLength(1);
  });

  it.each([
    ['an index line', (n: number) => `index ${'a'.repeat(n - 6)}`],
    ['a mode line', (n: number) => `old mode 100644${' '.repeat(n - 15)}`],
  ])('is taken at the bound and refused one past it: %s', (_, make) => {
    expect(readPatchText(withHeader(make(MAXIMUM_HEADER_LINE)), 'p')).toEqual(
      expect.any(Array),
    );
    expect(() =>
      readPatchText(withHeader(make(MAXIMUM_HEADER_LINE + 1)), 'p'),
    ).toThrow(tooLong(MAXIMUM_HEADER_LINE + 1));
  });

  it('is bounded by the prefixes the parser reads, which are these ten (readHeaderLine and the diff line)', () => {
    expect([...INTERPRETED_PREFIXES].sort()).toEqual(
      [
        'deleted file mode ',
        'diff --git ',
        'index ',
        'new file mode ',
        'new mode ',
        'old mode ',
        'rename from ',
        'rename to ',
        '+++ ',
        '--- ',
      ].sort(),
    );
  });

  it.each([...INTERPRETED_PREFIXES])(
    'is refused past the bound, wherever it is in the patch, when it begins like a header line the parser reads: %j',
    (prefix) => {
      const long = `${prefix}${'a'.repeat(MAXIMUM_HEADER_LINE)}`;
      // Before the first diff header, where a commit message sits, as well.
      for (const text of [
        withHeader(long),
        `${long}\n${withHeader('index 1..2')}`,
      ])
        expect(() => readPatchText(text, 'p')).toThrow(
          expect.objectContaining({ code: 'SIZE_LIMIT' }),
        );
    },
  );

  it.each([
    ['a commit message line', 'Subject: [PATCH] ' + 'word '.repeat(40_000)],
    ['a comment', `# ${'a'.repeat(200_000)}`],
    ['a mail header', `From: ${'x'.repeat(100_000)}`],
    ['a line pnpm reads as nothing', `similarity index ${'9'.repeat(100_000)}`],
    [
      'a binary notice',
      `Binary files a/x and b/x differ${' '.repeat(100_000)}`,
    ],
  ])(
    'is no bound on %s, which the parser does not read, before the diff or inside a file header',
    (_, line) => {
      const clean = readPatchText(withHeader('index 1..2'), 'p');
      expect(
        readPatchText(`${line}\n${withHeader('index 1..2')}`, 'p'),
      ).toEqual(clean);
      expect(readPatchText(withHeader(line), 'p')).toHaveLength(1);
    },
  );

  it('is refused as a diff line too, whatever follows the second path', () => {
    const spaces = ' '.repeat(MAXIMUM_HEADER_LINE);
    expect(() => readPatchText(withDiffLine(spaces), 'p')).toThrow(
      tooLong('diff --git a/f.js b/f.js'.length + MAXIMUM_HEADER_LINE),
    );
  });

  it('is refused at once when 40,000 characters long, where pnpm backtracks for seconds', () => {
    for (const text of [
      // `/(\w+)\.\.(\w+)/` over letters with no ".." in them: 5.8 s.
      withHeader(`index ${'a'.repeat(40_000)}`),
      // `/^diff --git a\/(.*?) b\/(.*?)\s*$/` over spaces and a letter: 4.4 s.
      withDiffLine(`${' '.repeat(40_000)}x`),
    ]) {
      const started = performance.now();
      expect(() => readPatchText(text, 'p')).toThrow(
        expect.objectContaining({ code: 'SIZE_LIMIT' }),
      );
      expect(performance.now() - started).toBeLessThan(3_000);
    }
  });

  it('is no bound on a line of a hunk, which is a line of the package', () => {
    const long = 'x'.repeat(200_000);
    const text = [
      'diff --git a/f.js b/f.js',
      '--- a/f.js',
      '+++ b/f.js',
      '@@ -1,2 +1,2 @@',
      ` ${long}`,
      '-a',
      '+b',
      '',
    ].join('\n');
    expect(readPatchText(text, 'p')).toHaveLength(1);
  });

  it('reads a hunk header of 200,000 digits in linear time', () => {
    const text = [
      'diff --git a/f.js b/f.js',
      '--- a/f.js',
      '+++ b/f.js',
      `@@ -${'1'.repeat(200_000)} +1 @@`,
      '-a',
      '+b',
      '',
    ].join('\n');
    const started = performance.now();
    expect(readPatchText(text, 'p')).toHaveLength(1);
    expect(performance.now() - started).toBeLessThan(3_000);
  });
});
