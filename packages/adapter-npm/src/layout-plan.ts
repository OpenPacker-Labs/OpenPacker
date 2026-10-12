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
import { checkLayoutLinks, type LayoutLink } from './layout-links.js';

export { compareVersions };

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
   * The name a direct entry is installed under when it is not its own
   * (`"string-width-cjs": "npm:string-width@^4"`). Directory names come from
   * here, never from `name`, which is what the package calls itself.
   */
  installName?: string;
  /** `id` of every entry this one requires under another name: name → id. */
  aliases?: Readonly<Record<string, string>>;
  source: NativeLockEntry;
}

export interface Placement {
  entry: LayoutEntry;
  /**
   * Package names from the project root down: `['b', 'c']` is
   * `node_modules/b/node_modules/c`.
   */
  chain: readonly string[];
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
}

interface Node {
  entry: LayoutEntry | undefined;
  parent: Node | undefined;
  children: Map<string, Node>;
  chain: readonly string[];
  /** The directory name, which is the entry's own unless it was aliased. */
  installName: string;
}

/** One edge, as the planner follows it: the entry and the name it is found by. */
interface Want {
  id: string;
  as: string;
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

/**
 * Most placements a plan may hold. A package that two dependents need at
 * different versions is placed once per dependent, so a lock built to nest
 * thousands of conflicting versions could otherwise ask for a tree of any size.
 */
export const MAXIMUM_PLACEMENTS = 50_000;

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

  // What each entry requires, and the name it finds each by. An alias name is
  // registry-controlled input that becomes a directory, so it is held to the
  // rule a package name is; an edge that fails is left out, with the reason.
  const wantsOf = (entry: LayoutEntry): Want[] => {
    const wants: Want[] = [];
    for (const id of new Set(entry.dependencies)) {
      const wanted = byId.get(id);
      if (wanted !== undefined) wants.push({ id, as: wanted.name });
    }
    for (const [as, id] of Object.entries(entry.aliases ?? {})) {
      const wanted = byId.get(id);
      if (wanted === undefined) continue;
      const problem = unsafeNameProblem(as);
      if (problem !== undefined) {
        skip(
          wanted,
          `${entry.name}@${entry.version} requires it as ${problem.replace(/^"[^"]*" /u, `"${as}" `)}`,
        );
        continue;
      }
      wants.push({ id, as });
    }
    // A package under its own name before one under an alias, so that when
    // two names differ only by case it is the alias that gives way.
    const aliased = (want: Want): number =>
      Number(want.as !== byId.get(want.id)?.name);
    return wants.sort(
      (left, right) =>
        aliased(left) - aliased(right) ||
        compareText(left.id, right.id) ||
        compareText(left.as, right.as),
    );
  };
  const wants = new Map(entries.map((entry) => [entry.id, wantsOf(entry)]));

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

/**
 * The directory beside which `name` would be written whose name differs from it
 * only by case. Two such names are one directory on a case-insensitive
 * filesystem (the default on macOS and Windows), and the second write would
 * replace the first without a word.
 */
function caseVariant(parent: Node, name: string): Node | undefined {
  const folded = name.toLowerCase();
  for (const [other, child] of parent.children)
    if (other !== name && other.toLowerCase() === folded) return child;
  return undefined;
}

function caseCollision(
  entry: LayoutEntry,
  name: string,
  variant: Node,
): string {
  return `${entry.name}@${entry.version} would be installed as ${name}, which differs only by case from ${variant.installName} (${variant.entry!.name}@${variant.entry!.version}) in the same directory; they are one directory on a case-insensitive filesystem`;
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

/** The directory a direct entry takes at the root. */
function directName(entry: LayoutEntry): string {
  return entry.installName ?? entry.name;
}

function sameEntry(left: LayoutEntry, right: LayoutEntry): boolean {
  return (
    left.id === right.id ||
    (left.name === right.name &&
      left.version === right.version &&
      left.digest === right.digest)
  );
}

function reachableFrom(
  roots: readonly LayoutEntry[],
  byId: ReadonlyMap<string, LayoutEntry>,
  usable: (entry: LayoutEntry | undefined) => entry is LayoutEntry,
  wants: ReadonlyMap<string, readonly Want[]>,
): Set<string> {
  const reached = new Set<string>();
  const pending = [...roots];
  while (pending.length > 0) {
    const entry = pending.pop()!;
    if (reached.has(entry.id)) continue;
    reached.add(entry.id);
    for (const { id } of wants.get(entry.id) ?? []) {
      const next = byId.get(id);
      if (usable(next)) pending.push(next);
    }
  }
  return reached;
}

/**
 * Which entry of each install name earns the root: a direct requirement, else
 * the one the most reachable packages require under that name, else the
 * newest. Only a name with more than one candidate needs an answer.
 */
function chooseRootVersions(
  entries: readonly LayoutEntry[],
  reachable: ReadonlySet<string>,
  usable: (entry: LayoutEntry | undefined) => entry is LayoutEntry,
  wants: ReadonlyMap<string, readonly Want[]>,
): Map<string, LayoutEntry> {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const wantedBy = new Map<string, number>();
  for (const entry of entries) {
    if (!reachable.has(entry.id)) continue;
    for (const { id, as } of wants.get(entry.id) ?? []) {
      const key = `${as}\0${id}`;
      wantedBy.set(key, (wantedBy.get(key) ?? 0) + 1);
    }
  }
  const byName = new Map<string, LayoutEntry[]>();
  const offer = (name: string, entry: LayoutEntry | undefined): void => {
    if (!usable(entry) || !reachable.has(entry.id)) return;
    byName.set(name, [...(byName.get(name) ?? []), entry]);
  };
  for (const entry of entries) {
    if (entry.direct) offer(directName(entry), entry);
    for (const { id, as } of wants.get(entry.id) ?? [])
      if (reachable.has(entry.id)) offer(as, byId.get(id));
  }
  const choice = new Map<string, LayoutEntry>();
  for (const [name, candidates] of byName) {
    const distinct = candidates.filter(
      (candidate, index) =>
        candidates.findIndex((other) => sameEntry(other, candidate)) === index,
    );
    if (distinct.length < 2) continue;
    const heldDirectly = (entry: LayoutEntry) =>
      Number(entry.direct && directName(entry) === name);
    distinct.sort(
      (left, right) =>
        heldDirectly(right) - heldDirectly(left) ||
        (wantedBy.get(`${name}\0${right.id}`) ?? 0) -
          (wantedBy.get(`${name}\0${left.id}`) ?? 0) ||
        compareVersions(right.version, left.version) ||
        compareText(left.id, right.id),
    );
    choice.set(name, distinct[0]!);
  }
  return choice;
}

function preferredFirst(
  entries: readonly LayoutEntry[],
  rootChoice: ReadonlyMap<string, LayoutEntry>,
): LayoutEntry[] {
  // With nothing known about who needs what, the newest version of a name wins
  // the root: the same answer a flat layout gave when a later entry replaced an
  // earlier one.
  return [...entries].sort(
    (left, right) =>
      Number(rootChoice.get(directName(right)) === right) -
        Number(rootChoice.get(directName(left)) === left) ||
      compareVersions(right.version, left.version) ||
      compareText(left.id, right.id),
  );
}

function sortEntries(entries: readonly LayoutEntry[]): LayoutEntry[] {
  return [...entries].sort(
    (left, right) =>
      compareText(left.name, right.name) ||
      compareVersions(left.version, right.version) ||
      compareText(left.id, right.id),
  );
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
