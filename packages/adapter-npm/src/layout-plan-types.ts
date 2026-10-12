/**
 * What a layout plan is made of: the packages it places, where it puts them,
 * the links it carries. The rule about which names a directory may have is
 * `layout-names.ts`.
 */

import type { NativeLockEntry } from '@openpacker/adapter-core';
import type { LayoutLink } from './layout-links.js';

/** One package the plan places. */
export interface LayoutEntry {
  /** Unique within the plan; what `dependencies` refer to. */
  id: string;
  name: string;
  version: string;
  digest: string;
  direct: boolean;
  /** `id` of every entry this one requires under that entry's own name. */
  dependencies: readonly string[];
  /**
   * The name an entry is installed under when it is not its own
   * (`"string-width-cjs": "npm:string-width@^4"`): the key of a direct
   * requirement, or the last name of the place a lock gave the package.
   * Directory names come from here (or from the placement's chain), never from
   * `name`, which is what the package calls itself.
   */
  installName?: string;
  /** `id` of every entry this one requires under another name: name → id. */
  aliases?: Readonly<Record<string, string>>;
  source: NativeLockEntry;
}

export interface Placement {
  entry: LayoutEntry;
  /**
   * Directory names from the project root down: `['b', 'c']` is
   * `node_modules/b/node_modules/c`. These are install names: for an aliased
   * package the last one is the alias, not the name the package calls itself
   * (`entry.name`).
   */
  chain: readonly string[];
  /**
   * The workspace member (its directory) whose own `node_modules` the chain
   * starts in; absent for the project's own `node_modules`. Each member's
   * `node_modules` is a directory of its own, with names of its own.
   */
  base?: string;
}

export interface LayoutSkip {
  entry: LayoutEntry;
  reason: string;
}

export interface LayoutPlan {
  /** Parents before the packages nested in them. */
  placements: readonly Placement[];
  skipped: readonly LayoutSkip[];
  /**
   * The workspace-member links, checked against the placements (see
   * `layout-links.ts`) and in path order. Empty unless the caller asked for some.
   */
  links: readonly LayoutLink[];
}

/** What a planner is told besides the packages. */
export interface PlanOptions {
  maximumPlacements?: number;
  /** Member links to carry in the plan; refused whole if any is not acceptable. */
  links?: readonly LayoutLink[];
  /**
   * The workspace member directories a package may be placed in. A package
   * placed under any other directory is refused: the lock does not get to name
   * where in the project a package is written.
   */
  members?: readonly string[];
}

/**
 * Most placements a plan may hold. A package that two dependents need at
 * different versions is placed once per dependent, so a lock built to nest
 * thousands of conflicting versions could otherwise ask for a tree of any size.
 */
export const MAXIMUM_PLACEMENTS = 50_000;

export class LayoutTooLargeError extends Error {
  readonly code = 'LAYOUT_TOO_LARGE';
  constructor(limit: number) {
    super(
      `The lock needs more than ${limit} package directories in node_modules; refusing to write a layout that large`,
    );
    this.name = 'LayoutTooLargeError';
  }
}
