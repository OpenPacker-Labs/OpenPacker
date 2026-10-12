import type {
  ParsedRange,
  ParsedVersion,
  RangeAst,
  SemverRangeOptions,
} from '../index.js';

/**
 * What the workspace model needs of a version grammar: to order two versions
 * and to say whether one satisfies a range. It is a port, not an import, so the
 * model does not depend on the module that owns npm's grammar; the package
 * entry builds the npm engine from the parser it already has
 * (`npmRangeEngine`) and callers pass it in.
 */
export interface RangeEngine {
  compareVersions(left: string, right: string): number;
  /**
   * Whether `version` satisfies `range` under npm's rules, or `undefined` when
   * `range` is not a semantic version range at all (a dist-tag, a URL, a path).
   */
  satisfies(version: string, range: string): boolean | undefined;
}

/** The parser functions the npm engine is built from. */
export interface SemverToolkit {
  parseSemver: (value: string, maximumReleaseParts?: number) => ParsedVersion;
  parseSemverRange: (value: string, options: SemverRangeOptions) => ParsedRange;
  evaluateSemverRange: (
    version: string,
    ast: RangeAst,
    compare: (left: string, right: string) => number,
  ) => boolean;
  compareParsedVersions: (left: ParsedVersion, right: ParsedVersion) => number;
}

/**
 * npm's reading of a range, as `semver.satisfies(version, range, true)` gives
 * it: loose, and without prereleases unless a comparator names one on the same
 * version. `*` and the empty range accept every version, prereleases included,
 * which is the one case npm's dependency check decides before it asks semver.
 */
export function createNpmRangeEngine(toolkit: SemverToolkit): RangeEngine {
  const compareVersions = (left: string, right: string): number =>
    toolkit.compareParsedVersions(
      toolkit.parseSemver(left, 3),
      toolkit.parseSemver(right, 3),
    );
  return {
    compareVersions,
    satisfies: (version, range) => {
      if (range.trim() === '' || range.trim() === '*') return true;
      try {
        const parsed = toolkit.parseSemverRange(range, {
          scheme: 'npm',
          bare: 'exact',
          hyphenRanges: true,
        });
        return toolkit.evaluateSemverRange(
          version,
          parsed.ast,
          compareVersions,
        );
      } catch {
        return undefined;
      }
    },
  };
}

/** SemVer 2.0.0's own grammar: three numbers, no leading zeros, optional prerelease and build. */
const STRICT_VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

export function isStrictVersion(text: string): boolean {
  return text.length <= 256 && STRICT_VERSION.test(text);
}
