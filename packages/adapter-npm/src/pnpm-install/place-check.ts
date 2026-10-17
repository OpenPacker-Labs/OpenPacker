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

import { enclosingDirs, type PlaceInput, type Placement } from './place.js';
import { quote } from './quote.js';

/** What is at one place. */
type Occupant =
  | { readonly kind: 'instance'; readonly key: string }
  | { readonly kind: 'link'; readonly memberDir: string };

function placeKey(base: string, chain: readonly string[]): string {
  return `${base}\u0001${chain.join('\0')}`;
}

/** Every `node_modules` Node looks in from a directory, nearest first, as (base, chain) of the directory that holds the name. */
function lookups(
  base: string,
  chain: readonly string[],
  as: string,
  members: ReadonlySet<string>,
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
  const found = (
    base: string,
    chain: readonly string[],
    as: string,
  ): Occupant | undefined => {
    for (const key of lookups(base, chain, as, members)) {
      const hit = at.get(key);
      if (hit !== undefined) return hit;
    }
    return undefined;
  };
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
