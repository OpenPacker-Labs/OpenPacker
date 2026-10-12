/**
 * What the planner is told of a selection: the instances being installed with
 * only the edges that lead to another of them, and the importers with the
 * edges and links that are kept.
 */

import type { PlaceInput } from './place.js';
import type { PnpmModel } from './model.js';
import type { Selection } from './select.js';

export function placeInputOf(
  model: PnpmModel,
  selection: Selection,
  tops: ReadonlySet<string>,
): PlaceInput {
  const instances = new Map(
    [...selection.included.keys()].map((key) => {
      const instance = model.instances.get(key)!;
      return [
        key,
        {
          key,
          name: instance.name,
          version: instance.version,
          edges: instance.edges
            .filter((edge) => selection.included.has(edge.to))
            .map((edge) => ({ as: edge.as, to: edge.to })),
        },
      ] as const;
    }),
  );
  return {
    instances,
    tops: [...tops].sort().map((id) => {
      const top = model.tops.get(id)!;
      const edges = selection.topEdges.get(id) ?? [];
      return {
        id,
        dir: top.dir,
        edges: edges.flatMap((edge) =>
          edge.kind === 'dep' ? [{ as: edge.as, to: edge.to }] : [],
        ),
        links: edges.flatMap((edge) =>
          edge.kind === 'link' &&
          edge.memberId !== undefined &&
          tops.has(edge.memberId)
            ? [{ as: edge.as, memberDir: model.tops.get(edge.memberId)!.dir }]
            : [],
        ),
      };
    }),
  };
}
