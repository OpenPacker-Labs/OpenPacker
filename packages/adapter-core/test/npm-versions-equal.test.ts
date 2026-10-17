import { describe, expect, it } from 'vitest';
import { npmVersionsEqual } from '../src/index.js';

/**
 * pnpm's `equalOrSemverEqual`, which decides whether an archive's version is
 * the lock's: the same text, or node-semver's `eq(a, b, { loose: true })`.
 * Each answer below is semver 7.7.2's, the version pnpm 10.28 embeds.
 */
describe('npmVersionsEqual, as pnpm compares an archive with its lock', () => {
  it.each([
    ['1.0.0', 'v1.0.0', true],
    ['1.0.0', '=1.0.0', true],
    ['1.0.0', 'vv1.0.0', true],
    ['1.0.0', '01.0.0', true],
    ['1.0.0', '1.0.0+build', true],
    ['1.0.0-1', '1.0.0-01', true],
    ['1.0.0-beta', '1.0.0beta', true],
    ['1.0', '1.0', true],
    ['1.0.0', '1.0.1', false],
    ['1.0.0', '1.0.0-1', false],
    ['1.0.0-1', '1.0.0-2', false],
    ['1.0', '1.0.0', false],
    ['9007199254740992.0.0', '9007199254740992.0.0', true],
    ['9007199254740992.0.0', '09007199254740992.0.0', false],
  ] as const)('answers %j and %j: %j', (left, right, expected) => {
    expect(npmVersionsEqual(left, right)).toBe(expected);
    expect(npmVersionsEqual(right, left)).toBe(expected);
  });
});
