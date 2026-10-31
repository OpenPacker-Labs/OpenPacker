import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { npmRangeEngine } from '../src/index.js';

/**
 * workspace-range-oracle.json holds what semver 7.7.2 (the copy in npm 10.9.4,
 * `satisfies(version, range, true)`, as npm's dependency check calls it)
 * answered for every range and version in
 * test/fixtures/workspace-oracle/ranges.mjs.
 *
 * The engine reads an npm range as node-semver does (npm-semver-range.ts), so
 * it answers every pair as npm does. It used to read partial versions its own
 * way and differed on 86 of these ranges; a difference now is a regression.
 */
const oracle: {
  versions: string[];
  answers: Record<string, boolean[] | null>;
} = JSON.parse(
  readFileSync(
    new URL('./fixtures/workspace-range-oracle.json', import.meta.url),
    'utf8',
  ),
);

/** What npm's dependency check answers: `*` and the empty range accept everything, prereleases included. */
function npmSays(range: string, at: number): boolean | undefined {
  const answers = oracle.answers[range];
  if (answers === null || answers === undefined) return undefined;
  return range.trim() === '' || range.trim() === '*' ? true : answers[at];
}

function differences(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const range of Object.keys(oracle.answers))
    oracle.versions.forEach((version, at) => {
      const theirs = npmSays(range, at);
      const mine = npmRangeEngine.satisfies(version, range);
      if (mine !== theirs)
        found.set(range, [
          ...(found.get(range) ?? []),
          `${version}: ${mine}, semver ${theirs}`,
        ]);
    });
  return found;
}

describe('the range engine against semver', () => {
  const found = differences();

  it('asks about enough ranges and versions to mean something', () => {
    expect(Object.keys(oracle.answers).length).toBeGreaterThanOrEqual(289);
    expect(oracle.versions.length).toBeGreaterThanOrEqual(23);
    expect(Object.values(oracle.answers).filter((a) => a === null).length).toBe(
      12,
    );
  });

  it('agrees with npm on all 289 ranges and 6647 pairs', () => {
    expect(Object.keys(oracle.answers)).toHaveLength(289);
    expect(oracle.versions.length * Object.keys(oracle.answers).length).toBe(
      6647,
    );
    expect(Object.fromEntries(found)).toEqual({});
  });

  it('agrees on every full version, wildcard-free and prerelease range', () => {
    for (const range of [
      '1.2.3',
      '=1.2.3',
      'v1.2.3',
      '^1.2.3',
      '~1.2.3',
      '>1.2.3',
      '>=1.2.3',
      '<1.2.3',
      '<=1.2.3',
      '1.0.0 - 2.0.0',
      '1.2.3 - 2',
      '>=1.0.0 <2.0.0',
      '^1.0.0 || ^2.0.0',
      '<1.0.0 || >=2.0.0',
      '^1.2.3-rc.1',
      '>=1.2.3-rc.1 <1.2.4',
      '^1',
      '~1',
      '~1.2',
      '1',
      '1.x',
      '*',
      '',
      'x',
      '>=1',
      '<1',
      '<1.x',
      'latest',
      'file:../x',
      'workspace:*',
      '1.2.3.4',
    ]) {
      expect(oracle.answers).toHaveProperty([range]);
      expect(found.has(range), range).toBe(false);
    }
  });
});
