import type { LockPackage } from './types.js';

/**
 * The edges of the closure a lock records, whichever way they are written.
 *
 * An entry's `dependencies` are keys it requires under their own package name;
 * its `aliases` are keys it requires under another name. Anything that asks
 * "what does this entry need" asks here, so an alias target is never mistaken
 * for something nothing needs.
 */

/** One edge: the lock key it points at and the name the dependent finds it by. */
export interface LockEdge {
  key: string;
  /** Absent when the target is found under its own package name. */
  installName?: string;
}

export function lockEdges(pkg: LockPackage): LockEdge[] {
  return [
    ...(pkg.dependencies ?? []).map((key) => ({ key })),
    ...Object.entries(pkg.aliases ?? {})
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([installName, key]) => ({ key, installName })),
  ];
}

/** The distinct lock keys an entry needs, in a stable order. */
export function lockEdgeKeys(pkg: LockPackage): string[] {
  return [...new Set(lockEdges(pkg).map((edge) => edge.key))];
}

/**
 * Every key reachable from `roots` through the lock's edges. A key the lock
 * does not hold is reached, and left for the caller to report.
 */
export function reachableKeys(
  packages: Readonly<Record<string, LockPackage>>,
  roots: Iterable<string>,
): Set<string> {
  const reached = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const key = queue.shift()!;
    if (reached.has(key)) continue;
    reached.add(key);
    const pkg = packages[key];
    if (pkg !== undefined) queue.push(...lockEdgeKeys(pkg));
  }
  return reached;
}
