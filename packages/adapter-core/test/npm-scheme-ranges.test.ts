import { describe, expect, it } from 'vitest';
import {
  compareParsedVersions,
  evaluateSemverRange,
  parseSemver,
  parseSemverRange,
  rangeToConstraint,
  renderRange,
} from '../src/index.js';

/**
 * The npm scheme of the range parser, as the portable constraint sees it. An
 * npm range is read as node-semver reads it (`npm-semver-range.ts`): `^1.2.3`
 * keeps 2.0.0's prereleases out by its bound, `<2.0.0-0`, and so does a hyphen
 * range's partial upper end.
 */
describe('npm ranges in the range parser', () => {
  it('reads a caret, a hyphen range and a prerelease bound as node-semver does', () => {
    const compareNative = (left: string, right: string) =>
      compareParsedVersions(parseSemver(left), parseSemver(right));
    const caret = parseSemverRange('^1.2.3', {
      scheme: 'npm',
      bare: 'exact',
      hyphenRanges: true,
    });
    expect(renderRange(caret.ast)).toBe('>=1.2.3 <2.0.0-0');
    expect(evaluateSemverRange('1.9.0', caret.ast, compareNative)).toBe(true);
    expect(rangeToConstraint(caret)).toMatchObject({
      reversible: false,
      semanticLoss: [{ code: 'NATIVE_RANGE_NOT_EXACTLY_REPRESENTABLE' }],
    });
    expect(
      parseSemverRange('1.2 - 1.4', {
        scheme: 'npm',
        bare: 'exact',
        hyphenRanges: true,
      }).normalized,
    ).toBe('>=1.2.0 <1.5.0-0');
    const prerelease = parseSemverRange('>=1.0.0-beta.1 <2.0.0', {
      scheme: 'npm',
      bare: 'exact',
      hyphenRanges: true,
    });
    expect(
      evaluateSemverRange('1.0.0-beta.2', prerelease.ast, compareNative),
    ).toBe(true);
  });
});
