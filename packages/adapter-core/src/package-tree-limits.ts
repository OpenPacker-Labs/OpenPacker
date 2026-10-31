/**
 * The bounds a package's files are held to in opm's store, whatever put them
 * there: an archive `opm ci` or `opm add` extracts (opm-project's
 * `frozenArchiveLimits` and `installArchiveLimits`), and the paths a pnpm patch
 * names (ADR 0057 §13), which become files of a store entry too. In depth and
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
 * one a pnpm patch's paths are held to (ADR 0057 §13), so that no path of a
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

/**
 * The directory every path of a package begins with in an archive (npm's
 * tarballs hold `package/...`). The materializer counts it, as a segment and
 * as bytes, in the bounds above; a path "below the package" is held to them
 * with it in front.
 */
export const PACKAGE_ROOT = 'package';

/**
 * What two entries of an archive are compared by, to refuse a pair that one
 * case-insensitive file system would make one file (`CASE_COLLISION`). The
 * materializer refuses an archive with two entries of one key, and the files
 * a pnpm patch creates are held to the same key against the files of the
 * package (ADR 0057 §13). A pair that differs only in Unicode normalization
 * (an NFC name beside an NFD one) has two keys, in an archive and in a patch.
 */
export const collisionKey = (path: string): string => path.toLowerCase();

/**
 * Bytes a system call takes in a path, the terminating NUL included (Linux's
 * `PATH_MAX`; macOS takes 1,024 and Windows fewer, neither is checked). The
 * directories the store keeps a package in count against it.
 */
export const SYSTEM_PATH_MAX = 4096;

/**
 * Why a path of `pathBytes` bytes cannot be made below a directory of
 * `directoryBytes` bytes, or undefined: the whole path is what the system
 * takes, and its parts passing their own bounds is not enough.
 */
export function wholePathProblem(
  directoryBytes: number,
  pathBytes: number,
): string | undefined {
  const total = directoryBytes + 1 + pathBytes;
  return total < SYSTEM_PATH_MAX
    ? undefined
    : `is ${pathBytes} bytes long, and below the ${directoryBytes}-byte directory it is made in comes to ${total} bytes, more than the ${SYSTEM_PATH_MAX - 1} a system call takes in a path`;
}
