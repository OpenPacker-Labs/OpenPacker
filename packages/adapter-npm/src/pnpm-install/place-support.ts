/**
 * Small constructors for the placement suites: instances, tops and a world of
 * both, written the way the cases read.
 */

import type { PlaceInput, PlaceInstance, PlaceTop } from './place.js';

/** `name@version(peers)`: the package's own name and version, as a key spells them. */
export function instance(
  key: string,
  edges: Record<string, string> = {},
): PlaceInstance {
  const base = key.split('(')[0]!;
  const at = base.lastIndexOf('@');
  return {
    key,
    name: base.slice(0, at),
    version: base.slice(at + 1),
    edges: Object.entries(edges).map(([as, to]) => ({ as, to })),
  };
}

export function top(
  dir: string,
  edges: Record<string, string> = {},
  links: Record<string, string> = {},
): PlaceTop {
  return {
    id: dir === '' ? '.' : dir,
    dir,
    edges: Object.entries(edges).map(([as, to]) => ({ as, to })),
    links: Object.entries(links).map(([as, memberDir]) => ({ as, memberDir })),
  };
}

export function world(
  instances: PlaceInstance[],
  tops: PlaceTop[],
): PlaceInput {
  return { instances: new Map(instances.map((i) => [i.key, i])), tops };
}
