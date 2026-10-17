/**
 * The orders the placement planner decides by (ADR 0055 §8 to §10): which
 * member directories enclose another, which edge of an instance is placed
 * first, and which instance of a name earns the project's `node_modules`.
 */

import { compareText, compareVersions } from '../layout-compare.js';
import type { PlaceInstance, PlaceTop } from './place-types.js';

/** The member directories that enclose `dir`, nearest first (never `dir`, never the project). */
export function enclosingDirs(
  dir: string,
  members: ReadonlySet<string>,
): string[] {
  const segments = dir.split('/');
  const out: string[] = [];
  for (let length = segments.length - 1; length > 0; length -= 1) {
    const candidate = segments.slice(0, length).join('/');
    if (members.has(candidate)) out.push(candidate);
  }
  return out;
}

/** A dependent's edges in the order they are placed: a package under its own name before an alias. */
export function orderedEdges<T extends { as: string; to: string }>(
  dependent: { readonly edges: readonly T[] },
  instances: ReadonlyMap<string, PlaceInstance>,
): T[] {
  const aliased = (edge: T): number =>
    Number(instances.get(edge.to)?.name !== edge.as);
  return [...dependent.edges].sort(
    (left, right) =>
      aliased(left) - aliased(right) ||
      compareText(left.as, right.as) ||
      compareText(left.to, right.to),
  );
}

/**
 * The instance of each install name that earns the project's `node_modules`:
 * the one the most instances and importers need under that name, then the
 * newest, then the smaller key. An importer's edge counts, so that two members
 * that share an instance elect it.
 */
export function rootChoice(
  instances: ReadonlyMap<string, PlaceInstance>,
  tops: readonly PlaceTop[],
): Map<string, string> {
  const counts = new Map<string, Map<string, number>>();
  for (const needer of [...instances.values(), ...tops])
    for (const edge of needer.edges) {
      const byTarget = counts.get(edge.as) ?? new Map<string, number>();
      counts.set(edge.as, byTarget);
      byTarget.set(edge.to, (byTarget.get(edge.to) ?? 0) + 1);
    }
  const choice = new Map<string, string>();
  for (const [as, byTarget] of counts) {
    const best = mostWanted(byTarget, instances);
    if (best !== undefined) choice.set(as, best);
  }
  return choice;
}

/** The key counted most, then the newest, then the smaller key. */
function mostWanted(
  counts: ReadonlyMap<string, number>,
  instances: ReadonlyMap<string, PlaceInstance>,
): string | undefined {
  return [...counts].sort(
    ([leftKey, left], [rightKey, right]) =>
      right - left ||
      compareVersions(
        instances.get(rightKey)?.version ?? '',
        instances.get(leftKey)?.version ?? '',
      ) ||
      compareText(leftKey, rightKey),
  )[0]?.[0];
}
