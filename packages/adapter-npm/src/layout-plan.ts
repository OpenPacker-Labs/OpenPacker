/**
 * Where each package of a closure goes in `node_modules`.
 *
 * Node resolves `require('c')` from a package by looking in that package's own
 * `node_modules`, then in each ancestor directory's, and takes the first match.
 * A closure that needs two versions of one name (`a` wants `c@1`, `b` wants
 * `c@2`) can therefore not be flat. This plans a tree that Node resolves to the
 * version the solve selected for every edge, the way npm lays one out, without
 * symlinks:
 *
 * - A direct requirement always lives at the root.
 * - Any other package lives at the root when nothing at the root, or between it
 *   and its dependent, already answers to that name, and when it is the version
 *   the most packages want. Otherwise it is nested in its dependent's own
 *   `node_modules`, which shadows the root for that package and its subtree only.
 * - Placement is decided by what Node would find from where a package really
 *   lives, so a nested package whose own dependency sits at the root is checked
 *   against the nested copy that shadows it, not assumed.
 *
 * Pure: no file is read or written here, so every rule below is testable with
 * synthetic entries.
 */

import type { NativeLockEntry } from '@openpacker/adapter-core';
import { compareText, compareVersions } from './layout-compare.js';
import {
  chooseRootVersions,
  directName,
  preferredFirst,
  reachableFrom,
  sameEntry,
  sortEntries,
  wantsOf,
} from './layout-choice.js';
import { checkLayoutLinks } from './layout-links.js';
import {
  caseCollision,
  caseVariant,
  quoted,
  unsafeNameProblem,
} from './layout-names.js';
import {
  LayoutTooLargeError,
  MAXIMUM_PLACEMENTS,
  type LayoutEntry,
  type LayoutPlan,
  type LayoutSkip,
  type PlanOptions,
} from './layout-plan-types.js';

export { compareVersions };
export { quoted, unsafeNameProblem };
export {
  LayoutTooLargeError,
  MAXIMUM_PLACEMENTS,
  type LayoutEntry,
  type LayoutPlan,
  type LayoutSkip,
  type PlanOptions,
  type Placement,
} from './layout-plan-types.js';
export {
  LayoutPathsError,
  planLayoutFromPaths,
  type PlacedEntry,
} from './layout-lock-plan.js';

interface Node {
  entry: LayoutEntry | undefined;
  parent: Node | undefined;
  children: Map<string, Node>;
  chain: readonly string[];
  /** The directory name, which is the entry's own unless it was aliased. */
  installName: string;
}

/** The id a lock entry is known by when its lock did not name it. */
export function layoutId(entry: NativeLockEntry): string {
  return entry.alias ?? `${entry.name}@${entry.version}`;
}

export function toLayoutEntries(
  entries: readonly NativeLockEntry[],
): LayoutEntry[] {
  const out: LayoutEntry[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const id = layoutId(entry);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: entry.name,
      version: entry.version,
      digest: entry.digest,
      direct: !entry.transitive,
      dependencies: entry.dependencies ?? [],
      ...(!(entry.installName === undefined) && {
        installName: entry.installName,
      }),
      ...(!(entry.aliases === undefined) && { aliases: entry.aliases }),
      source: entry,
    });
  }
  return out;
}

export function planLayout(
  entries: readonly LayoutEntry[],
  options: PlanOptions = {},
): LayoutPlan {
  const maximumPlacements = options.maximumPlacements ?? MAXIMUM_PLACEMENTS;
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const skipped: LayoutSkip[] = [];
  const skippedIds = new Set<string>();
  const skip = (entry: LayoutEntry, reason: string): void => {
    if (skippedIds.has(entry.id)) return;
    skippedIds.add(entry.id);
    skipped.push({ entry, reason });
  };

  const invalid = new Set<string>();
  for (const entry of entries) {
    const problem =
      unsafeNameProblem(entry.name) ??
      (entry.installName === undefined
        ? undefined
        : unsafeNameProblem(entry.installName));
    if (problem !== undefined) {
      invalid.add(entry.id);
      skip(entry, problem);
    }
  }
  const usable = (entry: LayoutEntry | undefined): entry is LayoutEntry =>
    entry !== undefined && !invalid.has(entry.id);

  const wants = new Map(
    entries.map((entry) => [entry.id, wantsOf(entry, byId, skip)]),
  );

  const reachable = reachableFrom(
    entries.filter((entry) => entry.direct && usable(entry)),
    byId,
    usable,
    wants,
  );
  const rootChoice = chooseRootVersions(entries, reachable, usable, wants);

  const root: Node = {
    entry: undefined,
    parent: undefined,
    children: new Map(),
    chain: [],
    installName: '',
  };
  const placed: Node[] = [];
  const placedIds = new Set<string>();
  const queue: Node[] = [];
  const place = (
    parent: Node,
    entry: LayoutEntry,
    installName: string,
  ): Node => {
    if (placed.length >= maximumPlacements)
      throw new LayoutTooLargeError(maximumPlacements);
    const node: Node = {
      entry,
      parent,
      children: new Map(),
      chain: [...parent.chain, installName],
      installName,
    };
    parent.children.set(installName, node);
    placed.push(node);
    placedIds.add(entry.id);
    queue.push(node);
    return node;
  };

  for (const entry of sortEntries(entries.filter((e) => e.direct))) {
    if (!usable(entry)) continue;
    const name = directName(entry);
    const taken = root.children.get(name)?.entry;
    if (taken !== undefined && !sameEntry(taken, entry)) {
      skip(
        entry,
        entry.installName === undefined && taken.installName === undefined
          ? `${entry.name}@${entry.version} is required directly, and so is ${taken.name}@${taken.version}; Node cannot resolve two versions of one name from the project root`
          : `${entry.name}@${entry.version} and ${taken.name}@${taken.version} are both required directly as ${name}; Node cannot resolve two packages of one name from the project root`,
      );
      continue;
    }
    const variant = caseVariant(root, name);
    if (variant !== undefined) {
      skip(entry, caseCollision(entry, name, variant));
      continue;
    }
    if (taken === undefined) place(root, entry, name);
  }

  const drain = (): void => {
    while (queue.length > 0) {
      const node = queue.shift()!;
      const dependent = node.entry!;
      for (const { id, as } of wants.get(dependent.id) ?? []) {
        const wanted = byId.get(id);
        if (!usable(wanted)) continue;
        const found = lookup(node, as);
        if (found !== undefined) {
          if (sameEntry(found.entry!, wanted)) continue;
          if (found.parent === node) {
            skip(
              wanted,
              `${dependent.name}@${dependent.version} requires both ${found.entry!.name}@${found.entry!.version} and ${wanted.name}@${wanted.version}${as === wanted.name ? '' : ` as ${as}`}`,
            );
            continue;
          }
          // A different version answers to this name from here: nest, so this
          // package and what it requires see the one the solve selected.
          const variant = caseVariant(node, as);
          if (variant !== undefined) {
            skip(wanted, caseCollision(wanted, as, variant));
            continue;
          }
          place(node, wanted, as);
          continue;
        }
        // Nothing answers to the name between here and the root. The root is the
        // best place for the version most of the closure wants; any other
        // version stays beside its dependent. A directory whose name differs
        // only by case from one already there would be the same directory on a
        // case-insensitive filesystem, so it goes beside its dependent instead.
        const preferred = rootChoice.get(as);
        const home =
          preferred === undefined || sameEntry(preferred, wanted) ? root : node;
        const where = caseVariant(home, as) === undefined ? home : node;
        const variant = caseVariant(where, as);
        if (variant !== undefined) {
          skip(wanted, caseCollision(wanted, as, variant));
          continue;
        }
        place(where, wanted, as);
      }
    }
  };
  drain();

  // Entries no requirement reaches through a recorded edge: a lock with no
  // edges at all (an offline lock), or a package whose parent's edges were not
  // captured. Dropping them would lose installed packages, so they take the
  // root when it is free, the way a flat layout always did.
  const orphans = sortEntries(
    entries.filter(
      (entry) =>
        usable(entry) &&
        !reachable.has(entry.id) &&
        !skippedIds.has(entry.id) &&
        !placedIds.has(entry.id),
    ),
  );
  for (const entry of preferredFirst(orphans, rootChoice)) {
    const name = directName(entry);
    const taken = root.children.get(name)?.entry;
    const variant = caseVariant(root, name);
    if (variant !== undefined) skip(entry, caseCollision(entry, name, variant));
    else if (taken === undefined) {
      place(root, entry, name);
      // It is installed, so what it requires has to resolve too.
      drain();
    } else if (!sameEntry(taken, entry))
      skip(
        entry,
        `${entry.name}@${entry.version} is not required by any recorded dependency edge and ${taken.name}@${taken.version} already holds the name`,
      );
  }

  const placements = placed
    .map((node) => ({ entry: node.entry!, chain: node.chain }))
    .sort(
      (left, right) =>
        left.chain.length - right.chain.length ||
        compareText(left.chain.join('\0'), right.chain.join('\0')),
    );
  return {
    placements,
    skipped,
    links: checkLayoutLinks(options.links ?? [], placements),
  };
}

/** One package with the place its lock gave it. */
export interface PlacedEntry {
  entry: LayoutEntry;
  /** Package names from the project root down, as in {@link Placement}. */
  chain: readonly string[];
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
  const taken = new Map<string, LayoutEntry>();
  for (const { entry, chain } of placed) {
    const where = chain.join('/node_modules/');
    if (chain.length === 0) {
      problems.push(`${entry.id} has no place`);
      continue;
    }
    const bad = chain
      .map((name) => unsafeNameProblem(name))
      .find((problem) => problem !== undefined);
    if (bad !== undefined) {
      problems.push(bad);
      continue;
    }
    const key = chain.join('\0');
    const rival = taken.get(key);
    if (rival !== undefined) {
      problems.push(
        `${rival.id} and ${entry.id} both claim node_modules/${where}`,
      );
      continue;
    }
    taken.set(key, entry);
  }
  for (const { entry, chain } of placed) {
    if (chain.length < 2) continue;
    if (!taken.has(chain.slice(0, -1).join('\0')))
      problems.push(
        `${entry.id} lives inside ${chain.slice(0, -1).join('/node_modules/')}, which is not installed`,
      );
  }
  if (problems.length > 0) throw new LayoutPathsError(problems);
  const placements = placed
    .map(({ entry, chain }) => ({ entry, chain }))
    .sort(
      (left, right) =>
        left.chain.length - right.chain.length ||
        compareText(left.chain.join('\0'), right.chain.join('\0')),
    );
  return {
    placements,
    skipped: [],
    links: checkLayoutLinks(options.links ?? [], placements),
  };
}

export class LayoutTooLargeError extends Error {
  readonly code = 'LAYOUT_TOO_LARGE';
  constructor(limit: number) {
    super(
      `The lock needs more than ${limit} package directories in node_modules; refusing to write a layout that large`,
    );
    this.name = 'LayoutTooLargeError';
  }
}

/** What Node finds for `name` from the directory this package lives in. */
function lookup(from: Node, name: string): Node | undefined {
  for (
    let current: Node | undefined = from;
    current;
    current = current.parent
  ) {
    const hit = current.children.get(name);
    if (hit !== undefined) return hit;
  }
  return undefined;
}
