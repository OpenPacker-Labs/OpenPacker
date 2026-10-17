/**
 * The bounds a package's files are held to in opm's store, whatever put them
 * there: an archive `opm ci` or `opm add` extracts (opm-project's
 * `frozenArchiveLimits` and `installArchiveLimits`), and the paths a pnpm patch
 * names (ADR 0056 §13), which become files of a store entry too. In depth and
 * length they are the materializer's own; in files they are a dependency
 * tree's, where some packages ship tens of thousands.
 */
export const PACKAGE_TREE_LIMITS = {
  /** Files in one package. */
  maximumFiles: 100_000,
  /** UTF-8 bytes in one path below the package. */
  maximumPathBytes: 4096,
  /** Segments in one path below the package. */
  maximumDepth: 128,
} as const;

/** A path segment an archive refuses, and why. */
export interface SegmentProblem {
  /** The code the materializer refuses an archive entry with. */
  readonly code:
    | 'WINDOWS_ALTERNATE_DATA_STREAM'
    | 'WINDOWS_RESERVED_NAME'
    | 'WINDOWS_TRAILING_CHARACTER';
  readonly reason: string;
}

/**
 * What is wrong with one segment of a path in a package, or undefined: the
 * names an archive refuses on every platform, the materializer's rule and the
 * one a pnpm patch's paths are held to (ADR 0056 §13), so that no path of a
 * patched entry is one an archive could not hold.
 *
 * Windows device names are reserved at every directory level and stay
 * reserved with an extension, so extracting an entry called `CON` or
 * `aux.txt` there writes to a device rather than a file. A `:` names an
 * alternate data stream. Trailing dots and spaces are stripped on resolution,
 * so `a.` and `a` would name one file on Windows and two here, which defeats
 * the duplicate and case-collision checks. All are refused on every platform,
 * because a package that only extracts safely on Linux is not safely
 * extractable.
 */
export function segmentProblem(segment: string): SegmentProblem | undefined {
  if (segment.includes(':'))
    return {
      code: 'WINDOWS_ALTERNATE_DATA_STREAM',
      reason: 'names an alternate data stream (a ":")',
    };
  if (/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(segment))
    return {
      code: 'WINDOWS_RESERVED_NAME',
      reason: 'is a Windows device name, with or without an extension',
    };
  if (/[ .]$/u.test(segment))
    return {
      code: 'WINDOWS_TRAILING_CHARACTER',
      reason: 'ends in a dot or a space, which Windows takes off',
    };
  return undefined;
}
