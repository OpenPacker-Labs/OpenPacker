/**
 * What the placement planner is given and what it answers (ADR 0055 §8 to §11).
 */

/** An edge: the name it is found by, the instance, and whether it is a peer. */
export interface PlaceEdge {
  readonly as: string;
  readonly to: string;
  /** Declared in the package's `peerDependencies`. */
  readonly peer?: boolean;
}

/** What the planner needs of an instance. */
export interface PlaceInstance {
  readonly key: string;
  /** The package's own name. */
  readonly name: string;
  readonly version: string;
  /** Edges to instances of the plan only. */
  readonly edges: readonly PlaceEdge[];
}

/** An importer the plan installs. */
export interface PlaceTop {
  readonly id: string;
  /** `''` for the project. */
  readonly dir: string;
  readonly edges: readonly { readonly as: string; readonly to: string }[];
  /** Members it links, by the name it finds them by. */
  readonly links: readonly {
    readonly as: string;
    readonly memberDir: string;
  }[];
}

export interface PlaceInput {
  readonly instances: ReadonlyMap<string, PlaceInstance>;
  /** The project first when it is installed, then the members. */
  readonly tops: readonly PlaceTop[];
  readonly maximumPlacements?: number;
  /**
   * The most places a layout made with peers in view may take; by default
   * eight for each instance and importer, and 256 more. Past it the planner
   * lays the lock out without peers in view instead.
   */
  readonly peerPlacements?: number;
}

/** One instance at one place. */
export interface PlacedInstance {
  readonly key: string;
  /** The member whose `node_modules` the chain starts in; `''` for the project's. */
  readonly base: string;
  /** Install names from that `node_modules` down. */
  readonly chain: readonly string[];
  /**
   * A direct dependency of an importer: in its own `node_modules`, or a
   * member's in the project's (or an enclosing member's) where it is shared.
   */
  readonly direct: boolean;
}

export interface PlacedLink {
  /** The name it takes in the project's `node_modules`. */
  readonly name: string;
  readonly memberDir: string;
}

export interface Placement {
  readonly placed: readonly PlacedInstance[];
  readonly links: readonly PlacedLink[];
  /** Things that cannot be laid out; any one stops the install. */
  readonly problems: readonly string[];
}

/** An edge whose dependency loads another copy of a peer its dependent requires too. */
export interface SplitEdge {
  /** The importer (by directory, `''` for the project) whose subtree the dependent sits in. */
  readonly importer: string;
  /** The dependent's instance key; absent when the dependent is the importer itself. */
  readonly dependent?: string;
  /** The instance the edge points at, which loads the other copy. */
  readonly dependency: string;
}

/** What the planner answers: the places, and how it came by them. */
export interface PlannedPlacement extends Placement {
  /**
   * Layouts made, the one returned included: at most `MAXIMUM_LAYOUTS` for
   * each way of sharing (two) under each way of pinning (two), and one more
   * when the layout was made without peers in view.
   */
  readonly layouts: number;
  /** Whether the layout was made without peers in view, because none with them could be written. */
  readonly fallback: boolean;
  /** The importers (by directory) whose packages the layout keeps in their own `node_modules`, because sharing left a split or no layout. */
  readonly isolated: readonly string[];
  /** Edges of the layout whose dependency loads another copy of a peer its dependent requires too. */
  readonly splits: number;
  /** The first of them, when there are any: what a notice about them names. */
  readonly firstSplit?: SplitEdge;
}
