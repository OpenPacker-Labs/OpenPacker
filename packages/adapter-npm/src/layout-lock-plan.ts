/**
 * Lay out exactly the places a lock names.
 *
 * `planLayout` (layout-plan.ts) has to decide where each package goes, because
 * an opm lock records which package needs which and not where Node should find
 * it. An npm lock already says: its key is the path, in the project's own
 * `node_modules` or in a workspace member's.
 */

import { compareText } from './layout-compare.js';
import { checkLayoutLinks, placePath } from './layout-links.js';
import { unsafeNameProblem } from './layout-names.js';
import {
  LayoutTooLargeError,
  MAXIMUM_PLACEMENTS,
  type LayoutEntry,
  type LayoutPlan,
  type PlanOptions,
  type Placement,
} from './layout-plan-types.js';

/** One package with the place its lock gave it. */
export interface PlacedEntry {
  entry: LayoutEntry;
  /** Package names from the project root down, as in {@link Placement}. */
  chain: readonly string[];
  /** The member whose `node_modules` the chain starts in, as in {@link Placement}. */
  base?: string;
}

function placementKey(base: string, chain: readonly string[]): string {
  return `${base}\u0001${chain.join('\0')}`;
}

function comparePlacements(left: Placement, right: Placement): number {
  return (
    left.chain.length - right.chain.length ||
    compareText(left.base ?? '', right.base ?? '') ||
    compareText(left.chain.join('\0'), right.chain.join('\0'))
  );
}

/** A lock whose placements cannot be laid out as written. */
export class LayoutPathsError extends Error {
  readonly code = 'LAYOUT_PATHS_INVALID';
  constructor(readonly problems: readonly string[]) {
    super(
      `The lock's placements cannot be written as they are: ${problems.slice(0, 10).join('; ')}${problems.length > 10 ? `; and ${problems.length - 10} more` : ''}`,
    );
    this.name = 'LayoutPathsError';
  }
}

/**
 * Lay out exactly the places a lock names.
 *
 * `planLayout` has to decide where each package goes, because an opm lock
 * records which package needs which and not where Node should find it. An npm
 * lock already says: its key is the path. Re-planning from the edges would
 * choose a placement that is correct but not the lock's, and a frozen install
 * is meant to be the lock. So nothing is chosen here; the chains are checked
 * and sorted, parents before the packages nested in them.
 *
 * A placement that cannot be written (an unsafe name, two packages claiming one
 * place, a package inside a parent that is not installed) is an error, not a
 * skip: dropping it would install something other than the lock.
 */
export function planLayoutFromPaths(
  placed: readonly PlacedEntry[],
  options: PlanOptions = {},
): LayoutPlan {
  const maximumPlacements = options.maximumPlacements ?? MAXIMUM_PLACEMENTS;
  if (placed.length > maximumPlacements)
    throw new LayoutTooLargeError(maximumPlacements);
  const problems: string[] = [];
  const members = new Set(options.members ?? []);
  const taken = new Map<string, LayoutEntry>();
  for (const { entry, chain, base = '' } of placed) {
    const where = placePath(chain, base);
    if (chain.length === 0) {
      problems.push(`${entry.id} has no place`);
      continue;
    }
    if (base !== '' && !members.has(base)) {
      problems.push(
        `${entry.id} lives in ${base}, which is not a workspace member the layout was given`,
      );
      continue;
    }
    const bad = chain
      .map((name) => unsafeNameProblem(name))
      .find((problem) => problem !== undefined);
    if (bad !== undefined) {
      problems.push(bad);
      continue;
    }
    const key = placementKey(base, chain);
    const rival = taken.get(key);
    if (rival !== undefined) {
      problems.push(`${rival.id} and ${entry.id} both claim ${where}`);
      continue;
    }
    taken.set(key, entry);
  }
  for (const { entry, chain, base = '' } of placed) {
    if (chain.length < 2) continue;
    if (!taken.has(placementKey(base, chain.slice(0, -1))))
      problems.push(
        `${entry.id} lives inside ${base === '' ? '' : `${base}/node_modules/`}${chain.slice(0, -1).join('/node_modules/')}, which is not installed`,
      );
  }
  if (problems.length > 0) throw new LayoutPathsError(problems);
  const placements = placed
    .map(({ entry, chain, base = '' }) => ({
      entry,
      chain,
      ...(base !== '' && { base }),
    }))
    .sort(comparePlacements);
  return {
    placements,
    skipped: [],
    links: checkLayoutLinks(options.links ?? [], placements),
  };
}
