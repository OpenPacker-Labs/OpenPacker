/**
 * npm's version and range grammar, applied.
 *
 * The codec and the frozen-lock reader both ask "does this version satisfy
 * this range"; they ask it here so there is one answer.
 */

import {
  compareParsedVersions,
  evaluateSemverRange,
  parseSemver,
  parseSemverRange,
  type ParsedRange,
  type ParsedVersion,
} from '@openpacker/adapter-core';

export function parseNpmVersion(value: string): ParsedVersion {
  return parseSemver(value, 3);
}

export function compareNpmVersions(left: string, right: string): number {
  return compareParsedVersions(parseNpmVersion(left), parseNpmVersion(right));
}

export function parseNpmRange(value: string): ParsedRange {
  return parseSemverRange(value, {
    scheme: 'npm',
    bare: 'exact',
    hyphenRanges: true,
  });
}

export function npmSatisfies(
  version: string,
  range: string | ParsedRange,
): boolean {
  return evaluateSemverRange(
    version,
    typeof range === 'string' ? parseNpmRange(range).ast : range.ast,
    compareNpmVersions,
  );
}
