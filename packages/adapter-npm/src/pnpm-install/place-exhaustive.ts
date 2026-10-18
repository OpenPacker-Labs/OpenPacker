/**
 * Every layout of a small placement world, searched (ADR 0055 §9), to tell a
 * split the planner keeps because no layout avoids it from one it failed to
 * avoid. Nothing of the planner is used: the search chooses, for each edge in
 * turn, where its dependency lives, and `place-check.ts` judges the layouts it
 * completes.
 *
 * A layout is a set of nodes (an instance, the name it is installed under, and
 * the `node_modules` it sits in: an importer's own or another node's). Every
 * edge must find its instance by Node's lookup, which tries the dependent's
 * own `node_modules` and then each enclosing one. A node that no edge finds
 * can be removed without changing any lookup, so each node is the answer to
 * some edge, and choosing the answer of every edge in turn visits each layout
 * once: an existing node, or a new one in any `node_modules` on the
 * dependent's way up, with every nearer one staying empty of that name for
 * ever.
 */

import { enclosingDirs } from './place-order.js';
import { peerSplitProblems, resolutionProblems } from './place-check.js';
import type { PlaceInput, Placement } from './place-types.js';

/** What a search found. */
export interface Search {
  /** A layout of at most `maximumNodes` nodes with no peer split, when there is one. */
  readonly found: Placement | undefined;
  /** Layouts completed (every edge found its instance) before the search stopped. */
  readonly complete: number;
}

/** A `node_modules`: an importer's own, or the one inside a node. */
interface Container {
  /** The container this one sits in; `-1` for the project's. */
  readonly parent: number;
  /** The importer's directory, for an importer's own. */
  readonly dir?: string;
  /** The instance and the install name, for a node. */
  readonly key?: string;
  readonly name?: string;
}

/** An edge still to be answered: who has it, the name, the instance. */
interface Requirement {
  readonly at: number;
  readonly as: string;
  readonly to: string;
}

interface State {
  readonly queue: readonly Requirement[];
  readonly position: number;
  /** `container|name` to the node that holds it. */
  readonly slots: ReadonlyMap<string, number>;
  /** Slots that must stay empty: a nearer one an edge looked through. */
  readonly forbidden: ReadonlySet<string>;
  readonly live: ReadonlySet<number>;
}

/**
 * The first layout of at most `maximumNodes` nodes that resolves every edge and
 * has no peer split, or none. Worlds with links between importers are not
 * searched.
 */
export function searchSplitFree(
  input: PlaceInput,
  maximumNodes: number,
): Search {
  if (input.tops.some((top) => top.links.length > 0))
    throw new Error('a world with links between importers is not searched');
  const dirs = input.tops.map((top) => top.dir);
  const members = new Set(dirs.filter((dir) => dir !== ''));
  const containers: Container[] = [];
  const topOf = new Map<string, number>();
  for (const dir of [...dirs].sort(
    (left, right) =>
      left.split('/').length - right.split('/').length ||
      (left < right ? -1 : 1),
  )) {
    const outer = enclosingDirs(dir, members)[0] ?? '';
    topOf.set(dir, containers.length);
    containers.push({
      dir,
      parent: dir === '' ? -1 : (topOf.get(outer) ?? 0),
    });
  }
  const start: Requirement[] = input.tops.flatMap((top) =>
    top.edges.map((edge) => ({
      at: topOf.get(top.dir)!,
      as: edge.as,
      to: edge.to,
    })),
  );

  let complete = 0;
  let found: Placement | undefined;

  const placementOf = (live: ReadonlySet<number>): Placement => {
    const placed = [...live].map((index) => {
      const chain: string[] = [];
      let at = index;
      while (containers[at]!.name !== undefined) {
        chain.unshift(containers[at]!.name!);
        at = containers[at]!.parent;
      }
      return {
        key: containers[index]!.key!,
        base: containers[at]!.dir!,
        chain,
        direct: false,
      };
    });
    return { placed, links: [], problems: [] };
  };

  const search = (state: State): void => {
    if (found !== undefined) return;
    const requirement = state.queue[state.position];
    if (requirement === undefined) {
      const placement = placementOf(state.live);
      if (resolutionProblems(input, placement).length > 0) return;
      complete += 1;
      if (peerSplitProblems(input, placement).length === 0) found = placement;
      return;
    }
    const { at, as, to } = requirement;
    const options: {
      readonly use: boolean;
      readonly container: number;
      readonly nearer: readonly string[];
    }[] = [];
    const empty: string[] = [];
    for (let up = at; up !== -1; up = containers[up]!.parent) {
      const slot = `${up}|${as}`;
      const holder = state.slots.get(slot);
      if (holder !== undefined) {
        if (containers[holder]!.key === to)
          options.push({ use: true, container: up, nearer: [...empty] });
        break;
      }
      if (!state.forbidden.has(slot))
        options.push({ use: false, container: up, nearer: [...empty] });
      empty.push(slot);
    }
    for (const option of options) {
      const forbidden = new Set([...state.forbidden, ...option.nearer]);
      if (option.use) {
        search({ ...state, position: state.position + 1, forbidden });
        if (found !== undefined) return;
        continue;
      }
      const slot = `${option.container}|${as}`;
      if (state.live.size >= maximumNodes || forbidden.has(slot)) continue;
      const index = containers.length;
      containers.push({ parent: option.container, key: to, name: as });
      search({
        queue: state.queue.concat(
          input.instances
            .get(to)!
            .edges.map((edge) => ({ at: index, as: edge.as, to: edge.to })),
        ),
        position: state.position + 1,
        slots: new Map([...state.slots, [slot, index]]),
        forbidden,
        live: new Set([...state.live, index]),
      });
      containers.pop();
      if (found !== undefined) return;
    }
  };

  search({
    queue: start,
    position: 0,
    slots: new Map(),
    forbidden: new Set(),
    live: new Set(),
  });
  return { found, complete };
}
