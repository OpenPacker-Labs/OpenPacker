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
