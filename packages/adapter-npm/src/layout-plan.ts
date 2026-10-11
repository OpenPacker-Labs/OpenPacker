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
}

export interface LayoutSkip {
  entry: LayoutEntry;
  reason: string;
}

export interface LayoutPlan {
  /** Parents before the packages nested in them. */
  placements: readonly Placement[];
  skipped: readonly LayoutSkip[];
}

interface Node {
  entry: LayoutEntry | undefined;
  parent: Node | undefined;
  children: Map<string, Node>;
  chain: readonly string[];
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
      source: entry,
    });
  }
  return out;
}

export function planLayout(entries: readonly LayoutEntry[]): LayoutPlan {
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
    const problem = unsafeNameProblem(entry.name);
    if (problem !== undefined) {
      invalid.add(entry.id);
      skip(entry, problem);
    }
  }
  const usable = (entry: LayoutEntry | undefined): entry is LayoutEntry =>
    entry !== undefined && !invalid.has(entry.id);

  const reachable = reachableFrom(
    entries.filter((entry) => entry.direct && usable(entry)),
    byId,
    usable,
  );
  const rootChoice = chooseRootVersions(entries, reachable, usable);

  const root: Node = {
    entry: undefined,
    parent: undefined,
    children: new Map(),
    chain: [],
  };
  const placed: Node[] = [];
  const placedIds = new Set<string>();
  const queue: Node[] = [];
  const place = (parent: Node, entry: LayoutEntry): Node => {
    const node: Node = {
      entry,
      parent,
      children: new Map(),
      chain: [...parent.chain, entry.name],
    };
    parent.children.set(entry.name, node);
    placed.push(node);
    placedIds.add(entry.id);
    queue.push(node);
    return node;
  };

  for (const entry of sortEntries(entries.filter((e) => e.direct))) {
    if (!usable(entry)) continue;
    const taken = root.children.get(entry.name)?.entry;
    if (taken !== undefined && !sameEntry(taken, entry)) {
      skip(
        entry,
        `${entry.name}@${entry.version} is required directly, and so is ${taken.name}@${taken.version}; Node cannot resolve two versions of one name from the project root`,
      );
      continue;
    }
    if (taken === undefined) place(root, entry);
  }

  const drain = (): void => {
    while (queue.length > 0) {
      const node = queue.shift()!;
      const dependent = node.entry!;
      for (const id of [...dependent.dependencies].sort()) {
        const wanted = byId.get(id);
        if (!usable(wanted)) continue;
        const found = lookup(node, wanted.name);
        if (found !== undefined) {
          if (sameEntry(found.entry!, wanted)) continue;
          if (found.parent === node) {
            skip(
              wanted,
              `${dependent.name}@${dependent.version} requires both ${found.entry!.name}@${found.entry!.version} and ${wanted.name}@${wanted.version}`,
            );
            continue;
          }
          // A different version answers to this name from here: nest, so this
          // package and what it requires see the one the solve selected.
          place(node, wanted);
          continue;
        }
        // Nothing answers to the name between here and the root. The root is the
        // best place for the version most of the closure wants; any other
        // version stays beside its dependent.
        const preferred = rootChoice.get(wanted.name);
        place(
          preferred === undefined || sameEntry(preferred, wanted) ? root : node,
          wanted,
        );
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
    const taken = root.children.get(entry.name)?.entry;
    if (taken === undefined) {
      place(root, entry);
      // It is installed, so what it requires has to resolve too.
      drain();
    } else if (!sameEntry(taken, entry))
      skip(
        entry,
        `${entry.name}@${entry.version} is not required by any recorded dependency edge and ${taken.name}@${taken.version} already holds the name`,
      );
  }

  return {
    placements: placed
      .map((node) => ({ entry: node.entry!, chain: node.chain }))
      .sort(
        (left, right) =>
          left.chain.length - right.chain.length ||
          compareText(left.chain.join('\0'), right.chain.join('\0')),
      ),
    skipped,
  };
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
): Set<string> {
  const reached = new Set<string>();
  const pending = [...roots];
  while (pending.length > 0) {
    const entry = pending.pop()!;
    if (reached.has(entry.id)) continue;
    reached.add(entry.id);
    for (const id of entry.dependencies) {
      const next = byId.get(id);
      if (usable(next)) pending.push(next);
    }
  }
  return reached;
}

/**
 * Which version of each name earns the root: a direct requirement, else the
 * one the most reachable packages require, else the newest. Only a name with
 * more than one candidate needs an answer.
 */
function chooseRootVersions(
  entries: readonly LayoutEntry[],
  reachable: ReadonlySet<string>,
  usable: (entry: LayoutEntry | undefined) => entry is LayoutEntry,
): Map<string, LayoutEntry> {
  const wantedBy = new Map<string, number>();
  for (const entry of entries) {
    if (!reachable.has(entry.id)) continue;
    for (const id of new Set(entry.dependencies))
      wantedBy.set(id, (wantedBy.get(id) ?? 0) + 1);
  }
  const byName = new Map<string, LayoutEntry[]>();
  for (const entry of entries) {
    if (!usable(entry) || !reachable.has(entry.id)) continue;
    byName.set(entry.name, [...(byName.get(entry.name) ?? []), entry]);
  }
  const choice = new Map<string, LayoutEntry>();
  for (const [name, candidates] of byName) {
    const distinct = candidates.filter(
      (candidate, index) =>
        candidates.findIndex((other) => sameEntry(other, candidate)) === index,
    );
    if (distinct.length < 2) continue;
    distinct.sort(
      (left, right) =>
        Number(right.direct) - Number(left.direct) ||
        (wantedBy.get(right.id) ?? 0) - (wantedBy.get(left.id) ?? 0) ||
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
      Number(rootChoice.get(right.name) === right) -
        Number(rootChoice.get(left.name) === left) ||
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

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Numeric-aware, not full semver: only ever used to make a choice repeatable. */
export function compareVersions(left: string, right: string): number {
  const split = (value: string) =>
    value
      .split(/[.+-]/u)
      .map((part) => (/^\d+$/u.test(part) ? Number(part) : part));
  const a = split(left);
  const b = split(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const x = a[index];
    const y = b[index];
    if (x === y) continue;
    if (x === undefined) return typeof y === 'string' ? 1 : -1;
    if (y === undefined) return typeof x === 'string' ? -1 : 1;
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    return compareText(String(x), String(y));
  }
  return 0;
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
      body === 'node_modules' ||
      !/^[A-Za-z0-9._~+-]+$/u.test(body)
    )
      return `${JSON.stringify(name)} is not a safe directory name for node_modules`;
  }
  return undefined;
}
