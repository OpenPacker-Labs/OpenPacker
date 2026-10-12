import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { npmRangeEngine } from '../src/index.js';

/**
 * workspace-range-oracle.json holds what semver 7.7.2 (the copy in npm 10.9.4,
 * `satisfies(version, range, true)`, as npm's dependency check calls it)
 * answered for every range and version in
 * test/fixtures/workspace-oracle/ranges.mjs.
 *
 * The engine is not semver on partial versions. This test does not hide that:
 * it pins which ranges differ, in which class, and how many, so a fix to the
 * parser fails it and sends the ADR's figures to be corrected, and a new
 * difference fails it too. Everything else, including every full x.y.z range,
 * `||`, hyphen ranges between full versions and prereleases, must agree.
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

const PARTIAL = String.raw`(?:\*|[xX]|\d+(?:\.(?:\d+|[xX*])(?:\.(?:\d+|[xX*]))?)?)`;
const VPARTIAL = String.raw`v\d+(?:\.\d+)?`;
const classes: readonly [name: string, test: RegExp, count: number][] = [
  [
    'a partial version with a leading v, after any operator',
    new RegExp(`^(?:[=^~<>]|[<>]=)?${VPARTIAL}$`, 'u'),
    16,
  ],
  [
    '"=" before a partial or wildcard version',
    new RegExp(`^=(?!v)${PARTIAL}$`, 'u'),
    16,
  ],
  [
    '"^" before a partial version whose major is 0',
    /^\^0(?:\.(?:0|x)(?:\.x)?)?$/u,
    5,
  ],
  [
    '"~" before a version whose minor is a wildcard',
    /^~(?:0|1)\.[xX*](?:\.[xX*])?$/u,
    6,
  ],
  [
    '">" before a partial or wildcard version',
    new RegExp(`^>(?!v)${PARTIAL}$`, 'u'),
    19,
  ],
  ['"<" before a wildcard', /^<(?:\*|x|X)$/u, 3],
  [
    '"<=" before a partial or wildcard version',
    new RegExp(`^<=(?!v)${PARTIAL}$`, 'u'),
    16,
  ],
  [
    'a range that contains one of the above',
    /^(?:>1 <=2|>=1 <=2 \|\| 0\.x)$/u,
    2,
  ],
  ['a hyphen range whose ends are wildcards', /^1\.x - 2\.x$/u, 1],
  ['an operator with no version', /^(?:\^|>=)$/u, 2],
];

describe('the range engine against semver', () => {
  const found = differences();

  it('asks about enough ranges and versions to mean something', () => {
    expect(Object.keys(oracle.answers).length).toBeGreaterThanOrEqual(289);
    expect(oracle.versions.length).toBeGreaterThanOrEqual(23);
    expect(Object.values(oracle.answers).filter((a) => a === null).length).toBe(
      12,
    );
  });

  it('differs on 86 of 289 ranges, 783 of 6647 pairs, and on no others', () => {
    expect(Object.keys(oracle.answers)).toHaveLength(289);
    expect(found.size).toBe(86);
    let pairs = 0;
    for (const list of found.values()) pairs += list.length;
    expect(pairs).toBe(783);
  });

  it('puts every difference in one of the classes the ADR names', () => {
    for (const range of found.keys()) {
      const named = classes.filter(([, test]) => test.test(range));
      expect(
        named.map(([name]) => name),
        range,
      ).toHaveLength(1);
    }
    for (const [name, test, count] of classes)
      expect(
        [...found.keys()].filter((range) => test.test(range)),
        name,
      ).toHaveLength(count);
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
