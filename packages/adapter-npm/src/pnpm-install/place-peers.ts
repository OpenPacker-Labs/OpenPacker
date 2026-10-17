/**
 * Peers in a pnpm lock's places (ADR 0055 §9).
 *
 * pnpm resolves a peer from the package that depends on the instance, and its
 * isolated layout gives each instance one real path, so a package and the
 * dependency it shares a peer with load one copy of that peer. A
 * `node_modules` tree keeps that only where the dependency, wherever it is
 * written, finds the very copy its dependent finds. An instance is therefore
 * written at the highest place on its dependent's way up from which each of
 * its peers that the dependent requires too resolves to the dependent's own
 * copy, and shared from above only when the copy above does so already.
 */

import type { PlaceEdge, PlaceInstance } from './place-types.js';
import { lookup, settle, type Node } from './place-tree.js';

type Edge = PlaceEdge;

/**
 * An instance's peer edges: those its package declares as peers, and those to
 * an instance its key carries in the peer suffix pnpm writes
 * (`dom@1.0.0(react@18.2.0)`).
 */
export function peerEdgesOf(instance: PlaceInstance): readonly Edge[] {
  const open = instance.key.indexOf('(');
  const suffix = open < 0 ? '' : instance.key.slice(open);
  return instance.edges.filter(
    (edge) =>
      edge.peer === true || (suffix !== '' && suffix.includes(`(${edge.to})`)),
  );
}

/**
 * `edges` (already in their order) with each placed after the edges of the
 * same dependent that hold its peers, so that where the dependent finds a peer
 * is settled before anything that shares it is placed. A cycle of peers keeps
 * the order it had.
 */
export function peersFirst<T extends Edge>(
  edges: readonly T[],
  peersOf: (key: string) => readonly Edge[],
): T[] {
  const byName = new Map<string, T>();
  for (const edge of edges) if (!byName.has(edge.as)) byName.set(edge.as, edge);
  const out: T[] = [];
  const done = new Set<T>();
  const open = new Set<T>();
  const visit = (edge: T): void => {
    if (done.has(edge) || open.has(edge)) return;
    open.add(edge);
    for (const peer of peersOf(edge.to)) {
      const mine = byName.get(peer.as);
      if (mine !== undefined && mine.to === peer.to) visit(mine);
    }
    open.delete(edge);
    done.add(edge);
    out.push(edge);
  };
  for (const edge of edges) visit(edge);
  return out;
}

/** A peer the dependency shares with its dependent, and the copy the dependent finds. */
export interface SharedPeer {
  readonly name: string;
  readonly at: Node;
}

/**
 * The peers of `to` that `from` requires too, under the same name and as the
 * same instance, each with the copy `from` finds.
 */
export function sharedPeers(
  from: Node,
  mine: ReadonlyMap<string, string>,
  peers: readonly Edge[],
): SharedPeer[] {
  const out: SharedPeer[] = [];
  for (const peer of peers) {
    if (mine.get(peer.as) !== peer.to) continue;
    const at = lookup(from, peer.as);
    if (at?.key === peer.to) out.push({ name: peer.as, at });
  }
  return out;
}

/** Whether a package that looks up from `at` finds each shared peer's own copy. */
function agrees(at: Node, shared: readonly SharedPeer[]): boolean {
  return shared.every((peer) => lookup(at, peer.name) === peer.at);
}

export interface HomeQuestion {
  readonly from: Node;
  readonly as: string;
  readonly to: string;
  /** What Node finds for `as` from `from` now. */
  readonly found: Node | undefined;
  /** Where a new copy goes when nothing is found and no peer is shared: the project, or `from`. */
  readonly plain: Node;
  readonly shared: readonly SharedPeer[];
  /** Whether a directory may take `as` (no name there differs from it only by case). */
  readonly fits: (at: Node) => boolean;
}

/**
 * Where `from`'s edge for `as` is answered: `'shared'` when the copy Node
 * already finds will do, else the node whose `node_modules` gets a new copy.
 * Another instance found under the name keeps the new copy beside `from`; one
 * that sees another copy of a shared peer goes only as high as every shared
 * peer still resolves to `from`'s copy, below anything that answers the name.
 * The answer is settled (`settle`), and so is each peer a shared copy is
 * relied on to find.
 */
export function homeOf(question: HomeQuestion): Node | 'shared' {
  const { from, as, to, found, plain, shared } = question;
  if (found !== undefined && found.key !== to) return from;
  if (found !== undefined && agrees(found, shared)) {
    for (const peer of shared) settle(found, peer.name, peer.at.parent!);
    settle(from, as, found.parent!);
    return 'shared';
  }
  if (found === undefined && (plain === from || agrees(plain, shared))) {
    settle(from, as, plain);
    return plain;
  }
  // Between `from` and whatever answers the name, as high as the peers allow.
  let best = from;
  for (
    let at = from.parent;
    at !== undefined && at !== found?.parent && agrees(at, shared);
    at = at.parent
  )
    if (!at.passed.has(as) && !at.children.has(as) && question.fits(at))
      best = at;
  settle(from, as, best);
  return best;
}

/**
 * The edges whose dependency, found above its dependent, loads another copy of
 * a peer the dependent requires as the same instance. Each is answered beside
 * its dependent on the next plan; `edgeId` names an edge across plans.
 */
export function peerSplits(
  dependents: Iterable<{
    readonly node: Node;
    readonly mine: ReadonlyMap<string, string>;
    readonly edges: readonly Edge[];
  }>,
  peersOf: (key: string) => readonly Edge[],
  edgeId: (node: Node, as: string) => string,
  pinned: ReadonlySet<string>,
): string[] {
  const splits: string[] = [];
  for (const { node, mine, edges } of dependents)
    for (const edge of edges) {
      const id = edgeId(node, edge.as);
      if (pinned.has(id)) continue;
      const found = lookup(node, edge.as);
      if (found?.key !== edge.to || found.parent === node) continue;
      const shared = sharedPeers(node, mine, peersOf(edge.to));
      if (!agrees(found, shared)) splits.push(id);
    }
  return splits;
}
