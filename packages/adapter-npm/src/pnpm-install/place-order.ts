/**
 * The orders the placement planner decides by (ADR 0055 §8 to §10): which
 * member directories enclose another, which edge of an instance is placed
 * first, and which instance of a name earns the project's `node_modules`.
 */

import { compareText, compareVersions } from '../layout-compare.js';
<<<<<<< ours
import type { Node } from './place-tree.js';
import type { PlaceInstance, PlaceTop } from './place-types.js';
=======
import type { PlaceInstance, PlaceTop } from './place.js';
>>>>>>> theirs

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

<<<<<<< ours
/** A dependent's edges in the order they are placed: a package under its own name before an alias. */
export function orderedEdges<T extends { as: string; to: string }>(
  dependent: { readonly edges: readonly T[] },
  instances: ReadonlyMap<string, PlaceInstance>,
): T[] {
  const aliased = (edge: T): number =>
    Number(instances.get(edge.to)?.name !== edge.as);
  return [...dependent.edges].sort(
=======
/** An instance's edges in the order they are placed: a package under its own name before an alias. */
export function orderedEdges(
  instance: PlaceInstance,
  instances: ReadonlyMap<string, PlaceInstance>,
): readonly { as: string; to: string }[] {
  const aliased = (edge: { as: string; to: string }): number =>
    Number(instances.get(edge.to)?.name !== edge.as);
  return [...instance.edges].sort(
>>>>>>> theirs
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
<<<<<<< ours
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

/**
 * The names whose slot in the project a plan left empty while one instance of
 * the name is written in two or more members' own `node_modules`, each with
 * the instance written in the most of them: given the slot, that instance has
<<<<<<< ours
 * one real path for all of those members. An isolated importer's are left
 * out: it keeps its packages to itself.
=======
 * one real path for all of those members.
>>>>>>> theirs
 */
export function emptySlotChoices(
  laid: {
    readonly project: Node;
    readonly placed: readonly Node[];
    readonly preferred: ReadonlyMap<string, string>;
  },
  instances: ReadonlyMap<string, PlaceInstance>,
<<<<<<< ours
  isolated: ReadonlySet<string>,
=======
>>>>>>> theirs
): Map<string, string> {
  const counts = new Map<string, Map<string, number>>();
  for (const node of laid.placed) {
    const name = node.installName;
    if (node.base === '' || node.chain.length !== 1) continue;
<<<<<<< ours
    if (isolated.has(node.base)) continue;
=======
>>>>>>> theirs
    if (laid.project.children.has(name)) continue;
    const byKey = counts.get(name) ?? new Map<string, number>();
    counts.set(name, byKey);
    byKey.set(node.key!, (byKey.get(node.key!) ?? 0) + 1);
  }
  const choices = new Map<string, string>();
  for (const [name, byKey] of counts) {
    const best = mostWanted(byKey, instances);
    if (
      best !== undefined &&
      byKey.get(best)! >= 2 &&
      laid.preferred.get(name) !== best
    )
      choices.set(name, best);
  }
  return choices;
}
=======
    const best = [...byTarget].sort(
      ([leftKey, left], [rightKey, right]) =>
        right - left ||
        compareVersions(
          instances.get(rightKey)?.version ?? '',
          instances.get(leftKey)?.version ?? '',
        ) ||
        compareText(leftKey, rightKey),
    )[0];
    if (best !== undefined) choice.set(as, best[0]);
  }
  return choice;
}
>>>>>>> theirs
