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
