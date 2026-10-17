/**
 * `indexHashes` and `diffLinePaths` give the match pnpm's two regexes give
 * (ADR 0056), and take a line in time linear in its length. The regexes are
 * kept here, as the reference, and run over short lines only: over a long one
 * they are the quadratic reading this module replaces.
 */

import { describe, expect, it } from 'vitest';
import { diffLinePaths, indexHashes } from './header-lines.js';

const INDEX = /(\w+)\.\.(\w+)/u;
const DIFF = /^diff --git a\/(.*?) b\/(.*?)\s*$/u;

const reference = (match: RegExpExecArray | null) =>
  match === null ? null : [match[1], match[2]];

/** A fixed seed, so a failure is the same line next time. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1103515245) + 12345) & 0x7fffffff;
    return state / 0x80000000;
  };
}

function lineOf(
  next: () => number,
  pieces: readonly string[],
  prefix: string,
): string {
  let line = prefix;
  for (let count = Math.floor(next() * 14); count > 0; count -= 1)
    line += pieces[Math.floor(next() * pieces.length)];
  return line;
}

describe('the index line, read in one pass', () => {
  const PIECES = [
    'index ',
    'abc',
    'a',
    '9',
    '_',
    '.',
    '..',
    '...',
    ' ',
    '\t',
    '-',
    'é',
    '٠',
    'ſ',
    'K',
    '100644',
  ];

  it('gives the groups of /(\\w+)\\.\\.(\\w+)/ and no match where it has none, over 60,000 lines', () => {
    const next = random(7);
    let matched = 0;
    for (let count = 0; count < 60_000; count += 1) {
      const line = lineOf(next, PIECES, 'index ');
      const expected = reference(INDEX.exec(line));
      expect(indexHashes(line), JSON.stringify(line)).toEqual(expected);
      if (expected !== null) matched += 1;
    }
    expect(matched).toBeGreaterThan(1_000);
    expect(matched).toBeLessThan(59_000);
  });

  it.each([
    ['index abc..def 100644', ['abc', 'def']],
    ['index a..b..c', ['a', 'b']],
    ['index a...b', null],
    ['index a.b..c', ['b', 'c']],
    ['index ..b', null],
    ['index a..', null],
    ['index a.. b', null],
    ['index éa..b', ['a', 'b']],
    ['index 0000000..1111111', ['0000000', '1111111']],
  ])('reads %j', (line, expected) => {
    expect(indexHashes(line)).toEqual(expected);
    expect(reference(INDEX.exec(line))).toEqual(expected);
  });

  it('takes 1,000,000 characters with no ".." in them at once, where the regex takes minutes', () => {
    const started = performance.now();
    expect(indexHashes(`index ${'a'.repeat(1_000_000)}`)).toBeNull();
    expect(indexHashes(`index ${'a.'.repeat(500_000)}`)).toBeNull();
    expect(indexHashes(`index ${'a'.repeat(1_000_000)}..b`)).toEqual([
      'a'.repeat(1_000_000),
      'b',
    ]);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe('the diff line, read in one pass', () => {
  const PIECES = [
    ' b/',
    ' b/',
    'a/',
    'a',
    'b',
    '/',
    ' ',
    '  ',
    '\t',
    '\r',
    '\n',
    ' ',
    ' ',
    ' ',
    '﻿',
    '　',
    '​',
    '.',
    'é',
  ];

  it('gives the groups of the regex, line terminators and whitespace included, over 120,000 lines', () => {
    const next = random(99);
    let matched = 0;
    for (let count = 0; count < 120_000; count += 1) {
      const line = lineOf(
        next,
        PIECES,
        next() < 0.9 ? 'diff --git a/' : 'diff --git ',
      );
      const expected = reference(DIFF.exec(line));
      expect(diffLinePaths(line), JSON.stringify(line)).toEqual(expected);
      if (expected !== null) matched += 1;
    }
    expect(matched).toBeGreaterThan(10_000);
  });

  it('takes the characters \\s names and trimEnd removes, all of them and no others', () => {
    const differing: string[] = [];
    for (let code = 0; code < 0x10000; code += 1) {
      const character = String.fromCharCode(code);
      if (/\s/u.test(character) !== (character.trimEnd() === ''))
        differing.push(`U+${code.toString(16)}`);
    }
    expect(differing).toEqual([]);
  });

  it.each([
    ['diff --git a/x b/y', ['x', 'y']],
    ['diff --git a/x b/y\r', ['x', 'y']],
    ['diff --git a/x b/y \t\r', ['x', 'y']],
    ['diff --git a/x b/y\rz', null],
    ['diff --git a/x\r b/y', null],
    ['diff --git a/x b/y z', null],
    ['diff --git a/x b/y  ', ['x', 'y']],
    ['diff --git a/a b/b b/c', ['a', 'b b/c']],
    ['diff --git a/ b/', ['', '']],
    ['diff --git a/a b/', ['a', '']],
    ['diff --git a/a b/ ', ['a', '']],
    ['diff --git a/a  b/b', ['a ', 'b']],
    ['diff --git a/a b/b c', ['a', 'b c']],
    ['diff --git a/a', null],
    ['diff --git b/a b/b', null],
    ['diff --git a/a\tb/b', null],
  ])('reads %j', (line, expected) => {
    expect(diffLinePaths(line)).toEqual(expected);
    expect(reference(DIFF.exec(line))).toEqual(expected);
  });

  it('takes 1,000,000 characters of spaces, " b/" and letters at once, where the regex takes hours', () => {
    const started = performance.now();
    const frame = 'diff --git a/f.js b/f.js';
    expect(diffLinePaths(`${frame}${' '.repeat(1_000_000)}x`)).toEqual([
      'f.js',
      `f.js${' '.repeat(1_000_000)}x`,
    ]);
    expect(diffLinePaths(`${frame}${' b/'.repeat(300_000)}x`)).toHaveLength(2);
    expect(diffLinePaths(`${frame}${'a '.repeat(500_000)}\rx`)).toBeNull();
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
