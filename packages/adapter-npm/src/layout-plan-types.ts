/**
 * What a layout plan is made of: the packages it places, where it puts them,
 * the links it carries, and the one rule about names that every place a package
 * can be written from a registry or a lock has to pass.
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
  dependencies: readonly string[];
  source: NativeLockEntry;
}

export interface Placement {
  entry: LayoutEntry;
  /**
   * Package names from the project root down: `['b', 'c']` is
   * `node_modules/b/node_modules/c`.
   */
  chain: readonly string[];
  /**
   * The workspace member (its directory) whose own `node_modules` the chain
   * starts in; absent for the project's own `node_modules`.
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

/**
 * Why a registry-supplied name is not a safe directory name, or undefined.
 *
 * A name becomes a path under a recursive delete, and a leading dot would let a
 * package replace `.bin`, so this is stricter than the registry's own rules.
 */
export function unsafeNameProblem(name: string): string | undefined {
  const segments = name.split('/');
  const scoped = name.startsWith('@');
  if (segments.length !== (scoped ? 2 : 1))
    return `${JSON.stringify(name)} is not an npm package name`;
  for (const [index, segment] of segments.entries()) {
    const body = scoped && index === 0 ? segment.slice(1) : segment;
    if (
      body === '' ||
      body.startsWith('.') ||
      body.toLowerCase() === 'node_modules' ||
      !/^[A-Za-z0-9._~+-]+$/u.test(body)
    )
      return `${JSON.stringify(name)} is not a safe directory name for node_modules`;
  }
  return undefined;
}
