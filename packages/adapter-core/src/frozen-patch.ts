/**
 * A patch a lock applies to a package before it is installed (pnpm's
 * `patchedDependencies`, ADR 0056), and the format hook that applies it.
 */

/** A patch file a lock applies to a package, read once by the adapter. */
export interface FrozenPatch {
  /** The key the lock declares it under: `name@version`, `name@range` or `name`. */
  readonly key: string;
  /** The patch file, relative to the project root, as the lock records it. */
  readonly file: string;
  /** The hash the lock records for it, checked against `text`. */
  readonly hash: string;
  /**
   * sha256, hex, of the patch file's bytes as read, the bytes `text` is and
   * the ones applied: what names the patched package. Not `hash`, which pnpm
   * takes of the text with CRLF made LF: an LF and a CRLF checkout of one
   * patch have one `hash`, and insert lines that end differently, so they are
   * two packages.
   */
  readonly digest: string;
  /** The file's text, as read and hashed: what is applied. */
  readonly text: string;
}

/** A format whose locks can patch a package. */
export interface FrozenPatchFormat {
  /**
   * Apply a patch `readFrozenLock` gave a package to that package's extracted
   * files in `packageDir`, a private copy no layout links yet: whole, or
   * throwing with the files as they were. Called after the archive was proved
   * to be the package the lock names, and before anything is published.
   */
  applyFrozenPatch?(
    packageDir: string,
    patch: FrozenPatch,
    label: string,
  ): Promise<void>;
  /**
   * The most bytes in a path the patch names, relative to the package: what
   * the host holds, with the directories it keeps the package in, to what the
   * system takes in a path before anything is fetched (`wholePathProblem`).
   */
  frozenPatchPathBytes?(patch: FrozenPatch): number;
}
