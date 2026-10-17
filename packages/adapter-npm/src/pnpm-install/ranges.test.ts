/**
 * Where `ranges.ts` disagreed with node-semver (the review of #179, round 2,
 * N3): every pair and form below is one the review's differential found, with
 * node-semver 7.7.2's answer (the version pnpm 10.28's own code embeds), and a
 * few beside them that must keep their answer.
 */

import { describe, expect, it } from 'vitest';
import {
  isRange,
  overrideRangeApplies,
  rangesIntersect,
  versionSatisfies,
} from './ranges.js';

/** The spellings of `>=0.0.0` the differential had, each `*` to node-semver. */
const AT_LEAST_ZERO = [
  '>=0.0.0',
  '>= 0.0.0',
  '>=0',
  '>= 0',
  '>=0.x',
  '>= 0.x',
  '>=0.0',
  '>= 0.0',
  '>=0.0.x',
  '>= 0.0.x',
];
const BELOW_ZERO = ['<0.0.0', '< 0.0.0'];

describe('rangesIntersect, against node-semver', () => {
  const pairs = BELOW_ZERO.flatMap((below) =>
    AT_LEAST_ZERO.flatMap((atLeast) => [
      [below, atLeast],
      [atLeast, below],
    ]),
  );

  it.each(pairs)(
    'takes %j and %j to intersect, as >=0.0.0 is *',
    (left, right) => {
      expect(rangesIntersect(left, right)).toBe(true);
      expect(overrideRangeApplies(left, right)).toBe(true);
    },
  );

  it.each([
    // 7.7.2 keeps the build, so this is `>=0.0.0` and not `*` (7.7.3: true).
    ['<0.0.0', '>=0.0.0+build', false],
    // `*` beside another comparator is dropped, as node-semver drops it.
    ['<0.0.0', '>=0.0.0 <1.0.0', false],
    ['<0.0.0', '* <1.0.0', false],
    // A prerelease bound is not `*`.
    ['<0.0.0', '>=0.0.0-0', false],
    ['<0.0.0', '<1.0.0', false],
    ['1.0.0', '>=0.0.0', true],
    ['>=0.0.0', '<0.0.0 || >1.0.0', true],
  ] as const)('answers %j and %j as node-semver does: %j', (a, b, expected) => {
    expect(rangesIntersect(a, b)).toBe(expected);
    expect(rangesIntersect(b, a)).toBe(expected);
  });
});

describe('isRange, against node-semver validRange', () => {
  it.each([
    'v1',
    'v1.2',
    'v0',
    'v0.0',
    'v0.1',
    'v1.x',
    'v1.2.x',
    'vx',
    'v*',
    'v0.x',
    'v1.*',
    'v2',
    'v1.X',
    'v0.0.x',
    '~>0.0.0',
    '~>0.0.1',
    '~>0.1.0',
    '~>0.1.2',
    '~>1.0.0',
    '~>1.2.3',
    '~>1.2.4',
    '~>2.0.0',
    '~>1.2.3-beta',
    '~>1.2.3-0',
    '~>1.2.3+b',
    '~>1',
    '~>1.2',
    '~>0',
    '~>0.0',
    '~>0.1',
    '~>1.x',
    '~>1.2.x',
    '~>x',
    '~>*',
    '~>0.x',
    '~>1.*',
    '~>2',
    '~>1.X',
    '~>0.0.x',
  ])('reads %j as a range, as node-semver does', (text) => {
    expect(isRange(text)).toBe(true);
  });

  it.each([
    ['>=v1.2 <v2', true],
    ['^v1', true],
    ['~>v1', true],
    ['1 - v2', true],
    ['v1 || v2', true],
    ['v1-beta', false],
    ['v 1', false],
    ['V1', false],
    ['latest', false],
  ] as const)('reads %j as node-semver does: %j', (text, expected) => {
    expect(isRange(text)).toBe(expected);
  });
});

describe('versionSatisfies, against node-semver satisfies', () => {
  // node-semver 7.7.2's answers. A version is read by the strict grammar, so a
  // numeric prerelease identifier with a leading zero is not a version at all.
  it.each([
    ['1.2.3-01', '>=1.2.3-0 <1.2.4', false],
    ['1.2.3-alpha.01', '>=1.2.3-0 <1.2.4', false],
    ['1.2.3-00', '>=1.2.3-0 <1.2.4', false],
    ['1.2.3-1', '>=1.2.3-0 <1.2.4', true],
    ['1.2.3-0', '>=1.2.3-0 <1.2.4', true],
    ['1.2.3-0a', '>=1.2.3-0 <1.2.4', true],
    ['1.2.3-alpha.1', '>=1.2.3-0 <1.2.4', true],
    ['01.2.3', '>=1.0.0', false],
    ['1.2', '>=1.0.0', false],
    ['=1.2.3', '>=1.0.0', false],
    ['v1.2.3', '>=1.0.0', true],
    [' 1.2.3 ', '>=1.0.0', true],
    ['1.2.3+b.01', '>=1.0.0', true],
  ] as const)(
    'answers %j in %j as node-semver does: %j',
    (version, range, expected) => {
      expect(versionSatisfies(version, range)).toBe(expected);
    },
  );
});
