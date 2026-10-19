/**
 * Proof that a placement gives every edge the instance it names (ADR 0055 §12).
 *
 * Node finds `require('x')` from a directory by looking in that directory's
 * `node_modules`, then in each ancestor directory's. On a placement that is: a
 * package's own `node_modules`, the one it sits in, every `node_modules` above
 * it down to the top it belongs to, then the `node_modules` of each member
 * directory that encloses that top, then the project's. This resolves every
 * edge of every instance and every top that way, from the placement alone (the
 * planner's tree is not consulted), and lists each edge that finds something
 * else.
 */

<<<<<<< ours
import { enclosingDirs } from './place-order.js';
import { peerEdgesOf } from './place-peers.js';
import type { PlaceInput, Placement } from './place-types.js';
=======
import { enclosingDirs, type PlaceInput, type Placement } from './place.js';
>>>>>>> theirs
import { quote } from './quote.js';

/** What is at one place. */
type Occupant =
  | { readonly kind: 'instance'; readonly key: string }
  | { readonly kind: 'link'; readonly memberDir: string };

<<<<<<< ours
/** A place: the member whose `node_modules` the chain starts in, and the chain. */
interface Place {
  readonly base: string;
  readonly chain: readonly string[];
}

=======
>>>>>>> theirs
function placeKey(base: string, chain: readonly string[]): string {
  return `${base}\u0001${chain.join('\0')}`;
}

<<<<<<< ours
/** Every place Node looks at for `as` from a directory, nearest first. */
=======
/** Every `node_modules` Node looks in from a directory, nearest first, as (base, chain) of the directory that holds the name. */
>>>>>>> theirs
function lookups(
  base: string,
  chain: readonly string[],
  as: string,
  members: ReadonlySet<string>,
<<<<<<< ours
): Place[] {
  const out: Place[] = [];
  for (let depth = chain.length; depth >= 0; depth -= 1)
    out.push({ base, chain: [...chain.slice(0, depth), as] });
  for (const outer of enclosingDirs(base, members))
    out.push({ base: outer, chain: [as] });
  if (base !== '') out.push({ base: '', chain: [as] });
  return out;
}

type Find = (
  from: Place,
  as: string,
) => (Place & { readonly occupant: Occupant }) | undefined;

/** Node's lookup over a placement: what a package at a place finds for a name, and where. */
function finder(input: PlaceInput, placement: Placement): Find {
=======
): string[] {
  const out: string[] = [];
  for (let depth = chain.length; depth >= 0; depth -= 1)
    out.push(placeKey(base, [...chain.slice(0, depth), as]));
  for (const outer of enclosingDirs(base, members))
    out.push(placeKey(outer, [as]));
  if (base !== '') out.push(placeKey('', [as]));
  return out;
}

/**
 * The edges of `input` that `placement` does not resolve, each as a sentence.
 * Empty when every instance, every top and every link finds what it needs.
 */
export function resolutionProblems(
  input: PlaceInput,
  placement: Placement,
): string[] {
>>>>>>> theirs
  const at = new Map<string, Occupant>();
  for (const item of placement.placed)
    at.set(placeKey(item.base, item.chain), {
      kind: 'instance',
      key: item.key,
    });
  for (const link of placement.links)
    if (!at.has(placeKey('', [link.name])))
      at.set(placeKey('', [link.name]), {
        kind: 'link',
        memberDir: link.memberDir,
      });
  const members = new Set(
    input.tops.map((top) => top.dir).filter((dir) => dir !== ''),
  );
<<<<<<< ours
  return (from, as) => {
    for (const place of lookups(from.base, from.chain, as, members)) {
      const occupant = at.get(placeKey(place.base, place.chain));
      if (occupant !== undefined) return { ...place, occupant };
    }
    return undefined;
  };
}

/**
 * The edges of `input` that `placement` does not resolve, each as a sentence.
 * Empty when every instance, every top and every link finds what it needs.
 */
export function resolutionProblems(
  input: PlaceInput,
  placement: Placement,
): string[] {
  const find = finder(input, placement);
=======
>>>>>>> theirs
  const found = (
    base: string,
    chain: readonly string[],
    as: string,
<<<<<<< ours
  ): Occupant | undefined => find({ base, chain }, as)?.occupant;
=======
  ): Occupant | undefined => {
    for (const key of lookups(base, chain, as, members)) {
      const hit = at.get(key);
      if (hit !== undefined) return hit;
    }
    return undefined;
  };
>>>>>>> theirs
  const describe = (hit: Occupant | undefined): string =>
    hit === undefined
      ? 'nothing'
      : hit.kind === 'instance'
        ? quote(hit.key)
        : `the link to ${quote(hit.memberDir)}`;

  const problems: string[] = [];
  const placedKeys = new Set(placement.placed.map((item) => item.key));
  for (const item of placement.placed)
    for (const edge of input.instances.get(item.key)?.edges ?? []) {
      const hit = found(item.base, item.chain, edge.as);
      if (hit?.kind !== 'instance' || hit.key !== edge.to)
        problems.push(
          `${quote(item.key)} at ${quote(`${item.base === '' ? '' : `${item.base}/`}node_modules/${item.chain.join('/node_modules/')}`)} needs ${quote(edge.as)} as ${quote(edge.to)}, and Node finds ${describe(hit)}`,
        );
    }
  for (const top of input.tops) {
    for (const edge of top.edges) {
      if (!input.instances.has(edge.to)) continue;
      const hit = found(top.dir, [], edge.as);
      if (hit?.kind !== 'instance' || hit.key !== edge.to)
        problems.push(
          `${quote(top.id)} needs ${quote(edge.as)} as ${quote(edge.to)}, and Node finds ${describe(hit)}`,
        );
    }
    for (const link of top.links) {
      const hit = found(top.dir, [], link.as);
      if (hit?.kind !== 'link' || hit.memberDir !== link.memberDir)
        problems.push(
          `${quote(top.id)} links ${quote(link.memberDir)} as ${quote(link.as)}, and Node finds ${describe(hit)}`,
        );
    }
  }
  for (const key of input.instances.keys())
    if (!placedKeys.has(key))
      problems.push(`${quote(key)} is in the plan and was given no place`);
  return problems;
}
<<<<<<< ours

const pathOf = (place: Place): string =>
  `${place.base === '' ? '' : `${place.base}/`}node_modules/${place.chain.join('/node_modules/')}`;

/** Every dependent of a placement, where it is and the edges it has. */
function dependents(
  input: PlaceInput,
  placement: Placement,
): { who: string; at: Place; edges: readonly { as: string; to: string }[] }[] {
  return [
    ...input.tops.map((top) => ({
      who: quote(top.id),
      at: { base: top.dir, chain: [] },
      edges: top.edges,
    })),
    ...placement.placed.map((item) => ({
      who: `${quote(item.key)} at ${quote(pathOf(item))}`,
      at: item,
      edges: input.instances.get(item.key)?.edges ?? [],
    })),
  ];
}

/**
 * Each place where a dependent and the dependency it finds load two copies of
 * one peer instance: the dependency has a peer the dependent requires too, as
 * the same instance, and finds it somewhere else (ADR 0055 §9). Empty when
 * every peer a package shares with its dependent is one module.
 */
export function peerSplitProblems(
  input: PlaceInput,
  placement: Placement,
): string[] {
  const find = finder(input, placement);
  const problems: string[] = [];
  for (const { who, at, edges } of dependents(input, placement)) {
    const mine = new Map(edges.map((edge) => [edge.as, edge.to]));
    for (const edge of edges) {
      const dependency = find(at, edge.as);
      const instance = input.instances.get(edge.to);
      if (dependency === undefined || instance === undefined) continue;
      for (const peer of peerEdgesOf(instance)) {
        if (mine.get(peer.as) !== peer.to) continue;
        const own = find(at, peer.as);
        if (own?.occupant.kind !== 'instance' || own.occupant.key !== peer.to)
          continue;
        const theirs = find(dependency, peer.as);
        if (theirs !== undefined && pathOf(theirs) === pathOf(own)) continue;
        problems.push(
          `${who} loads ${quote(peer.to)} from ${quote(pathOf(own))}, and its ${quote(edge.as)} at ${quote(pathOf(dependency))} loads another copy${theirs === undefined ? '' : ` from ${quote(pathOf(theirs))}`}`,
        );
      }
    }
  }
  return problems;
}

/**
 * Where each top's direct dependencies are: per top directory, each edge's
 * name and the place Node finds it at. A top's executables are its direct
 * dependencies', wherever they sit.
 */
export function directPlaces(
  input: PlaceInput,
  placement: Placement,
): Map<string, { as: string; place: Place }[]> {
  const find = finder(input, placement);
  const out = new Map<string, { as: string; place: Place }[]>();
  for (const top of input.tops)
    out.set(
      top.dir,
      top.edges.flatMap((edge) => {
        const hit = find({ base: top.dir, chain: [] }, edge.as);
        return hit?.occupant.kind === 'instance' && hit.occupant.key === edge.to
          ? [{ as: edge.as, place: { base: hit.base, chain: hit.chain } }]
          : [];
      }),
    );
  return out;
}
=======
>>>>>>> theirs
