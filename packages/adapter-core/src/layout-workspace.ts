/**
 * What a layout writes for a workspace, in terms every ecosystem's writer can
 * be handed.
 *
 * A frozen install of a workspace lock does not fetch its members: they are
 * directories of the project's own source. The layout links each installed
 * member's name to its directory and puts the executables a member declares
 * where the ecosystem's tool puts them. The ecosystem's adapter decides the
 * places and the text; the host only carries the answer from the lock reader to
 * the layout writer.
 */

/** A workspace member whose directory a layout links and whose executables it shims. */
export interface NativeLayoutMember {
  /** The member's directory, relative to the project root, `/`-separated. */
  dir: string;
  /** The name other packages depend on it by. */
  name: string;
  /** The executables its manifest declares, name to path inside the member. */
  bin: Readonly<Record<string, string>>;
}

/** A link from a member's name to its directory. */
export interface NativeLayoutLink {
  /** Project-relative place of the link, as the lock spells it. */
  path: string;
  /** The link's text, relative to the directory it sits in. */
  target: string;
}

export interface NativeLayoutWorkspace {
  /** The members this install links, each once. */
  members: readonly NativeLayoutMember[];
  links: readonly NativeLayoutLink[];
  /**
   * Each installed importer's direct dependencies and linked members, for a
   * tool that gives every importer the executables of its own (pnpm): their
   * shims go in the importer's own `.bin` wherever the packages were written,
   * and only they rank as the importer's own there; a member's executables
   * go to the importers that link it, and nowhere else. Absent, a package's
   * executables go in the `.bin` beside it and a member's in the project's,
   * as npm links them.
   */
  importers?: readonly {
    /** Relative to the project root, `/`-separated; `''` for the project. */
    readonly dir: string;
    /** Project-relative places of the packages it depends on directly. */
    readonly dependencies: readonly string[];
    /** Directories of the members it links: their own executables are its to run. */
    readonly members: readonly string[];
  }[];
}
