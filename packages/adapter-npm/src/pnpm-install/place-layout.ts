/**
 * One layout of a pnpm lock's instances in `node_modules` (ADR 0055 §8 to
 * §11), made under a strategy: which edges are answered beside their
 * dependent, which names give the project's slot to which instance, which
 * importers keep everything in their own `node_modules`, and how many places
 * the layout may take. `place.ts` makes layouts until one has no peer split.
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
import { LayoutTooLargeError } from '../layout-plan-types.js';
import { enclosingDirs, orderedEdges, rootChoice } from './place-order.js';
import { homeOf, peerEdgesOf, peersFirst, sharedPeers } from './place-peers.js';
import { lookup, settle, topNode, type Node } from './place-tree.js';
import type { PlaceEdge, PlaceInput, PlaceInstance } from './place-types.js';
import { quote } from './quote.js';

/** The deepest `node_modules` chain a plan may hold. Real locks stay far under it. */
export const MAXIMUM_DEPTH = 32;

export interface Laid {
  readonly project: Node;
  readonly tops: ReadonlyMap<string, Node>;
  readonly placed: readonly Node[];
  readonly links: ReadonlyMap<string, string>;
  readonly preferred: ReadonlyMap<string, string>;
  readonly problems: readonly string[];
  readonly loops: Loops;
}

/**
 * What a copy of a package nested below a copy of itself is shadowed by: the
 * packages between the two, as the install name and instance each was written
 * under (which the project's slots could be given to) and as the edge each was
 * written for (`pinId`, which could be written higher up).
 */
export interface Loops {
  readonly names: ReadonlyMap<string, string>;
  readonly edges: ReadonlySet<string>;
}

/**
 * A layout that took more places than it was given, with the packages that
 * sit inside a copy of themselves in it (`Laid.loops`): the
 * tree of a lock whose copies are each shadowed by the one above grows past
 * the bound before it is deep enough to be refused.
 */
export class LayoutOutgrown extends LayoutTooLargeError {
  constructor(
    limit: number,
    readonly loops: Loops,
  ) {
    super(limit);
  }
}

/** What a plan reads of the instances, worked out once. */
export interface Known {
  readonly peersOf: (key: string) => readonly PlaceEdge[];
  readonly mineOf: (key: string) => ReadonlyMap<string, string>;
}

/** What a plan reads of the instances, worked out once for all its layouts. */
export function knownOf(input: PlaceInput): Known {
  const peers = new Map<string, readonly PlaceEdge[]>();
  const mine = new Map<string, ReadonlyMap<string, string>>();
  for (const [key, instance] of input.instances) {
    peers.set(key, peerEdgesOf(instance));
    mine.set(key, new Map(instance.edges.map((edge) => [edge.as, edge.to])));
  }
  return {
    peersOf: (key) => peers.get(key) ?? [],
    mineOf: (key) => mine.get(key) ?? new Map(),
  };
}

/** What one layout is made under; `place.ts` changes it between layouts. */
export interface Strategy {
  /** Edges (`pinId`) answered beside their dependent whatever they find. */
  readonly pinned: ReadonlySet<string>;
  /** Names whose slot in the project goes to the instance given. */
  readonly elected: ReadonlyMap<string, string>;
  /** Edges (`pinId`) whose copy, where another instance answers the name, goes as high as its peers allow and not beside the dependent. */
  readonly lifted: ReadonlySet<string>;
  /** Importers (by directory) whose packages stay in their own `node_modules`, never in the project's. */
  readonly isolated: ReadonlySet<string>;
  /** The most places the layout may take: past it, `LayoutTooLargeError`. */
  readonly limit: number;
}

/**
 * An edge across layouts: the importer whose subtree the dependent sits in,
 * the dependent (an importer's by its directory, an instance by its key, every
 * copy of it in that subtree) and the name.
 */
export const pinId = (node: Node, as: string): string =>
  `${node.base}\u0002${node.key ?? ''}\u0000${as}`;

/** Whether `ancestor` is a node `node` sits below. */
function isAbove(ancestor: Node, node: Node): boolean {
  for (let at = node.parent; at !== undefined; at = at.parent)
    if (at === ancestor) return true;
  return false;
}

/**
 * One layout. An edge in the strategy's `pinned` is answered beside its
 * dependent unless the instance is one the dependent already sits inside; a
 * name in `elected` gives the project's slot to that instance; an isolated
 * importer's packages go no higher than its own `node_modules`.
 */
export function layOut(
  input: PlaceInput,
  known: Known,
  strategy: Strategy,
): Laid {
  const { instances } = input;
  const { pinned, elected, isolated, lifted } = strategy;
  const maximum = strategy.limit;
  const problems: string[] = [];
  const preferred = rootChoice(instances, input.tops);
  for (const [name, key] of elected) preferred.set(name, key);
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
  const loops = {
    names: new Map<string, string>(),
    edges: new Set<string>(),
  };
  /** The packages between `parent` and the nearest copy of `key` above it, if one is. */
  const betweenCopies = (parent: Node, key: string): void => {
    const between: Node[] = [];
    let at: Node | undefined = parent;
    for (; at !== undefined && at.key !== key; at = at.parent)
      if (at.key !== undefined) between.push(at);
    if (at === undefined) return;
    for (const node of between) {
      if (!loops.names.has(node.installName))
        loops.names.set(node.installName, node.key!);
      loops.edges.add(pinId(node.parent!, node.installName));
    }
  };
  const place = (
    parent: Node,
    instance: PlaceInstance,
    name: string,
    direct: boolean,
  ): void => {
    if (placed.length >= maximum) {
      for (const node of placed) betweenCopies(node.parent!, node.key!);
      betweenCopies(parent, instance.key);
      throw new LayoutOutgrown(maximum, loops);
    }
    // Two versions of two packages that need each other have no finite tree:
    // each copy nested beside its dependent is shadowed by the one above it.
    // pnpm writes that with symlinks, which a node_modules without them cannot.
    if (parent.chain.length >= MAXIMUM_DEPTH) {
      if (!tooDeep.has(instance.key) && tooDeep.size < 10)
        problems.push(
          `${quote(instance.key)} would sit more than ${MAXIMUM_DEPTH} directories deep: packages that need each other at different versions cannot be laid out as a tree without symlinks`,
        );
      tooDeep.add(instance.key);
      betweenCopies(parent, instance.key);
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
    const found = lookup(from, as);
    if (pinned.has(pinId(from, as))) {
      // Beside the dependent, unless the instance is one it sits inside: a
      // copy of it nested in its own copy would be nested again in that one.
      if (found?.key !== to || !isAbove(found, from)) return from;
      settle(from, as, found.parent!);
      return 'shared';
    }
    const ceiling = isolated.has(from.base) ? tops.get(from.base)! : project;
    const hoist =
      ceiling !== project || preferred.get(as) === to ? ceiling : undefined;
    return homeOf({
      from,
      as,
      to,
      found,
      plain:
        hoist !== undefined && caseVariant(hoist, as) === undefined
          ? hoist
          : from,
      ceiling,
      shared: sharedPeers(from, mine, known.peersOf(to)),
      fits: (at) => caseVariant(at, as) === undefined,
      climb: lifted.has(pinId(from, as)),
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

  return { project, tops, placed, links, preferred, problems, loops };
}
