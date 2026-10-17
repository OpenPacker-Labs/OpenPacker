/**
 * Where each instance of a pnpm lock goes in `node_modules` (ADR 0055 §8 to
 * §11).
 *
 * An npm lock records a place for every package, because arborist chose it when
 * npm wrote the lock. A pnpm lock records only what each package needs, so the
 * places are chosen here, once, the way the closure planner chooses them
 * (`layout-plan.ts`), for several tops instead of one:
 *
 * - the project's direct dependencies live in its `node_modules`; a member's
 *   are answered as everything else is, from the member's directory, so one
 *   lock instance has one real path, and so one module, wherever no other
 *   version holds its name;
 * - every edge is answered breadth first: if Node already finds the wanted
 *   instance from where the dependent lives, nothing is written; if it finds
 *   another instance of that name, the wanted one is nested beside the
 *   dependent; if it finds nothing, the instance of that name the most
 *   packages want goes to the project's `node_modules` and any other beside its
 *   dependent;
 * - except that an instance with a peer its dependent requires too is shared,
 *   or written, only where that peer resolves to the dependent's own copy
 *   (`place-peers.ts`): as high as that holds, and no higher;
 * - a member link takes `node_modules/<member name>` in the project;
 * - a member nested inside another member's directory looks in that member's
 *   `node_modules` before the project's, as Node does.
 *
 * Pure. `place-check.ts` resolves every edge on the result with Node's lookup
 * and is how a plan is proved.
 */

import { compareText } from '../layout-compare.js';
import {
  caseCollision,
  caseVariant,
  unsafeNameProblem,
} from '../layout-names.js';
import {
  LayoutTooLargeError,
  MAXIMUM_PLACEMENTS,
} from '../layout-plan-types.js';
import { enclosingDirs, orderedEdges, rootChoice } from './place-order.js';
import {
  homeOf,
  peerEdgesOf,
  peerSplits,
  peersFirst,
  sharedPeers,
} from './place-peers.js';
import { lookup, topNode, type Node } from './place-tree.js';
import type {
  PlaceEdge,
  PlaceInput,
  PlaceInstance,
  Placement,
} from './place-types.js';
import { quote } from './quote.js';

export { enclosingDirs } from './place-order.js';
export type {
  PlaceEdge,
  PlaceInput,
  PlaceInstance,
  PlacedInstance,
  PlacedLink,
  Placement,
  PlaceTop,
} from './place-types.js';

/** The deepest `node_modules` chain a plan may hold. Real locks stay far under it. */
export const MAXIMUM_DEPTH = 32;

interface Laid {
  readonly tops: ReadonlyMap<string, Node>;
  readonly placed: readonly Node[];
  readonly links: ReadonlyMap<string, string>;
  readonly problems: readonly string[];
}

/** What a plan reads of the instances, worked out once. */
interface Known {
  readonly peersOf: (key: string) => readonly PlaceEdge[];
  readonly mineOf: (key: string) => ReadonlyMap<string, string>;
}

/** An edge across plans: a top's by its directory, an instance's by its key (every copy of it). */
const edgeId = (node: Node, as: string): string =>
  node.key === undefined
    ? `\u0001${node.base}\u0000${as}`
    : `${node.key}\u0000${as}`;

/** One plan. An edge in `pinned` is answered beside its dependent whatever it finds. */
function layOut(
  input: PlaceInput,
  known: Known,
  pinned: ReadonlySet<string>,
): Laid {
  const { instances } = input;
  const maximum = input.maximumPlacements ?? MAXIMUM_PLACEMENTS;
  const problems: string[] = [];
  const preferred = rootChoice(instances, input.tops);
  const tops = new Map<string, Node>();
  const placed: Node[] = [];
  const queue: Node[] = [];
  const links = new Map<string, string>();

  const project = topNode('', undefined);
  tops.set('', project);
  const memberDirs = new Set(
    input.tops.map((top) => top.dir).filter((dir) => dir !== ''),
  );
  for (const top of [...input.tops].sort(
    (a, b) =>
      a.dir.split('/').length - b.dir.split('/').length ||
      compareText(a.dir, b.dir),
  ))
    if (top.dir !== '') {
      const outer = enclosingDirs(top.dir, memberDirs)[0];
      tops.set(
        top.dir,
        topNode(top.dir, outer === undefined ? project : tops.get(outer)),
      );
    }

  const tooDeep = new Set<string>();
  const place = (
    parent: Node,
    instance: PlaceInstance,
    name: string,
    direct: boolean,
  ): void => {
    if (placed.length >= maximum) throw new LayoutTooLargeError(maximum);
    // Two versions of two packages that need each other have no finite tree:
    // each copy nested beside its dependent is shadowed by the one above it.
    // pnpm writes that with symlinks, which a node_modules without them cannot.
    if (parent.chain.length >= MAXIMUM_DEPTH) {
      if (!tooDeep.has(instance.key) && tooDeep.size < 10)
        problems.push(
          `${quote(instance.key)} would sit more than ${MAXIMUM_DEPTH} directories deep: packages that need each other at different versions cannot be laid out as a tree without symlinks`,
        );
      tooDeep.add(instance.key);
      return;
    }
    const node: Node = {
      key: instance.key,
      parent,
      children: new Map(),
      base: parent.base,
      chain: [...parent.chain, name],
      installName: name,
      entry: { name: instance.name, version: instance.version },
      direct,
      passed: new Set(),
    };
    parent.children.set(name, node);
    placed.push(node);
    queue.push(node);
  };
  const held = (node: Node): string =>
    node.key === undefined ? 'a link' : quote(node.key);
  const refuseName = (name: string, who: string): boolean => {
    const problem = unsafeNameProblem(name);
    if (problem === undefined) return false;
    problems.push(`${who} needs ${problem}`);
    return true;
  };
  /** Where `from`'s edge is answered, peers considered; `'shared'` when nothing is written. */
  const answer = (
    from: Node,
    mine: ReadonlyMap<string, string>,
    as: string,
    to: string,
  ): Node | 'shared' => {
    if (pinned.has(edgeId(from, as))) return from;
    return homeOf({
      from,
      as,
      to,
      found: lookup(from, as),
      plain:
        preferred.get(as) === to && caseVariant(project, as) === undefined
          ? project
          : from,
      shared: sharedPeers(from, mine, known.peersOf(to)),
      fits: (at) => caseVariant(at, as) === undefined,
    });
  };

  // Round 0: links, then each top's own dependencies.
  for (const top of input.tops)
    for (const link of top.links) {
      if (refuseName(link.as, `${quote(top.id)}'s link`)) continue;
      const earlier = links.get(link.as);
      if (earlier !== undefined && earlier !== link.memberDir) {
        problems.push(
          `${quote(top.id)} links ${quote(link.memberDir)} as ${quote(link.as)}, which another importer links to ${quote(earlier)}; ${quote(`node_modules/${link.as}`)} cannot be both`,
        );
        continue;
      }
      links.set(link.as, link.memberDir);
    }
  for (const [name, memberDir] of links) {
    const earlier = project.children.get(name);
    if (earlier?.key !== undefined) continue;
    project.children.set(name, {
      ...topNode('', project),
      chain: [name],
      installName: name,
      entry: { name, version: '', label: `the link to ${quote(memberDir)}` },
    });
  }
  // The project's first, then members from the outermost: a member finds
  // what the project and its enclosing members already hold.
  const byDepth = [...input.tops].sort(
    (a, b) =>
      Number(a.dir !== '') - Number(b.dir !== '') ||
      a.dir.split('/').length - b.dir.split('/').length ||
      compareText(a.dir, b.dir),
  );
  for (const top of byDepth) {
    const node = tops.get(top.dir)!;
    const mine = new Map(top.edges.map((edge) => [edge.as, edge.to]));
    for (const edge of peersFirst(
      orderedEdges(top, instances),
      known.peersOf,
    )) {
      const instance = instances.get(edge.to);
      if (instance === undefined || refuseName(edge.as, quote(top.id)))
        continue;
      const taken = node.children.get(edge.as);
      if (taken !== undefined) {
        if (taken.key !== edge.to)
          problems.push(
            taken.key === undefined
              ? `${quote(top.id)} needs ${quote(edge.as)} (${quote(edge.to)}), and ${quote(`node_modules/${edge.as}`)} is the link to a workspace member that another importer needs`
              : `${quote(top.id)} needs ${quote(edge.as)} twice, as ${quote(taken.key)} and ${quote(edge.to)}`,
          );
        continue;
      }
      // The project's own go in its node_modules; a member's are answered as
      // everything else is, from the member's directory.
      const where =
        top.dir === '' ? node : answer(node, mine, edge.as, edge.to);
      if (where === 'shared') continue;
      const variant = caseVariant(where, edge.as);
      if (variant !== undefined) {
        problems.push(
          `${quote(top.id)}: ${caseCollision(instance, edge.as, variant)}`,
        );
        continue;
      }
      place(where, instance, edge.as, true);
    }
  }

  // Everything the placed instances need.
  for (let next = 0; next < queue.length; next += 1) {
    const node = queue[next]!;
    const instance = instances.get(node.key!)!;
    const mine = known.mineOf(instance.key);
    for (const { as, to } of peersFirst(
      orderedEdges(instance, instances),
      known.peersOf,
    )) {
      const wanted = instances.get(to);
      if (wanted === undefined || refuseName(as, quote(instance.key))) continue;
      const where = answer(node, mine, as, to);
      if (where === 'shared') continue;
      const variant = caseVariant(where, as);
      if (variant !== undefined) {
        problems.push(
          `${quote(instance.key)}: ${caseCollision(wanted, as, variant)}`,
        );
        continue;
      }
      if (where.children.has(as)) {
        problems.push(
          `${quote(instance.key)} needs ${quote(as)} as ${quote(to)}, and its own node_modules already holds ${held(where.children.get(as)!)} under that name`,
        );
        continue;
      }
      place(where, wanted, as, false);
    }
  }

  return { tops, placed, links, problems };
}

/** Every dependent of a plan: each top, then each placed instance. */
function* dependentsOf(input: PlaceInput, laid: Laid, known: Known) {
  for (const top of input.tops)
    yield {
      node: laid.tops.get(top.dir)!,
      mine: new Map(top.edges.map((edge) => [edge.as, edge.to])),
      edges: top.edges,
    };
  for (const node of laid.placed)
    yield {
      node,
      mine: known.mineOf(node.key!),
      edges: input.instances.get(node.key!)!.edges,
    };
}

export function planPlacement(input: PlaceInput): Placement {
  const peers = new Map<string, readonly PlaceEdge[]>();
  const mine = new Map<string, ReadonlyMap<string, string>>();
  for (const [key, instance] of input.instances) {
    peers.set(key, peerEdgesOf(instance));
    mine.set(key, new Map(instance.edges.map((edge) => [edge.as, edge.to])));
  }
  const known: Known = {
    peersOf: (key) => peers.get(key) ?? [],
    mineOf: (key) => mine.get(key) ?? new Map(),
  };
  // Each round pins at least one edge, of finitely many.
  const pinned = new Set<string>();
  let laid = layOut(input, known, pinned);
  for (;;) {
    if (laid.problems.length > 0) break;
    const splits = peerSplits(
      dependentsOf(input, laid, known),
      known.peersOf,
      edgeId,
      pinned,
    );
    if (splits.length === 0) break;
    for (const split of splits) pinned.add(split);
    laid = layOut(input, known, pinned);
  }
  const { placed, links, problems } = laid;
  return {
    placed: placed
      .map((node) => ({
        key: node.key!,
        base: node.base,
        chain: node.chain,
        direct: node.direct,
      }))
      .sort(
        (left, right) =>
          left.chain.length - right.chain.length ||
          compareText(left.base, right.base) ||
          compareText(left.chain.join('\0'), right.chain.join('\0')),
      ),
    links: [...links]
      .map(([name, memberDir]) => ({ name, memberDir }))
      .sort((left, right) => compareText(left.name, right.name)),
    problems,
  };
}
