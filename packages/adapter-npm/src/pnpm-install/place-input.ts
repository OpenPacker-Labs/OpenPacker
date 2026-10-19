/**
 * What the planner is told of a selection: the instances being installed with
<<<<<<< ours
 * only the edges that lead to another of them (a peer marked as one), and the
 * importers with the edges and links that are kept.
<<<<<<< ours
 *
 * A peer is an edge only where the lock resolved it. pnpm writes no edge for an
 * optional peer nothing provided, so the planner never sees one: there is no
 * copy of it to keep to one, and a cycle through optional peers is, to the
 * planner, a cycle through the peers that are resolved.
=======
>>>>>>> theirs
 */

import type { PlaceInput } from './place-types.js';
=======
 * only the edges that lead to another of them, and the importers with the
 * edges and links that are kept.
 */

import type { PlaceInput } from './place.js';
>>>>>>> theirs
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
<<<<<<< ours
            .map((edge) => ({
              as: edge.as,
              to: edge.to,
              ...(instance.pkg.peerDependencies.has(edge.as) && {
                peer: true,
              }),
            })),
=======
            .map((edge) => ({ as: edge.as, to: edge.to })),
>>>>>>> theirs
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
