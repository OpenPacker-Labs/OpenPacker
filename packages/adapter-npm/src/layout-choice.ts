/**
 * Which package takes which place, and who wants what: the choices the layout
 * planner makes from the lock's edges. Pure, so each rule is testable on
 * synthetic entries.
 */

import { compareText, compareVersions } from './layout-compare.js';
import { unsafeNameProblem } from './layout-names.js';
import type { LayoutEntry } from './layout-plan.js';

/** One edge, as the planner follows it: the entry and the name it is found by. */
export interface Want {
  id: string;
  as: string;
}

/**
 * What an entry requires, and the name it finds each by. An alias name is
 * registry-controlled input that becomes a directory, so it is held to the rule
 * a package name is; an edge that fails is left out, and `skip` is told why.
 * A package under its own name comes before one under an alias, so that when
 * two names differ only by case it is the alias that gives way.
 */
export function wantsOf(
  entry: LayoutEntry,
  byId: ReadonlyMap<string, LayoutEntry>,
  skip: (entry: LayoutEntry, reason: string) => void,
): Want[] {
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
  const aliased = (want: Want): number =>
    Number(want.as !== byId.get(want.id)?.name);
  return wants.sort(
    (left, right) =>
      aliased(left) - aliased(right) ||
      compareText(left.id, right.id) ||
      compareText(left.as, right.as),
  );
}

/** The directory a direct entry takes at the root. */
export function directName(entry: LayoutEntry): string {
  return entry.installName ?? entry.name;
}

export function sameEntry(left: LayoutEntry, right: LayoutEntry): boolean {
  return (
    left.id === right.id ||
    (left.name === right.name &&
      left.version === right.version &&
      left.digest === right.digest)
  );
}

export function reachableFrom(
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
export function chooseRootVersions(
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

export function preferredFirst(
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

export function sortEntries(entries: readonly LayoutEntry[]): LayoutEntry[] {
  return [...entries].sort(
    (left, right) =>
      compareText(left.name, right.name) ||
      compareVersions(left.version, right.version) ||
      compareText(left.id, right.id),
  );
}
