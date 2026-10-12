/**
 * The dependency graph a lock describes, as a frozen install walks it.
 *
 * Nodes are the lock's registry packages, the project itself (the "root", `''`)
 * and each workspace member. A node's edges go where Node would look for the
 * dependency from the directory it lives in: its own `node_modules`, then each
 * ancestor's, and for a package inside a member, the project's own last. A
 * name that resolves to no package but to a member's link is an edge to that
 * member.
 *
 * The root and the members are "tops": always installed, so an edge from one is
 * never *from* a package that could be dropped (`from: null`).
 */

import {
  resolveFromChain,
  type LockEntry,
  type PackageLockTree,
} from './lock-tree.js';

export interface Edge {
  /** Null for an edge from a top: the project's own manifest or a member's. */
  from: LockEntry | null;
  to: LockEntry;
  /** An optionalDependencies edge, or an optional peer. */
  optional: boolean;
}

export interface LockGraph {
  into: Map<LockEntry, Edge[]>;
  out: Map<LockEntry, Edge[]>;
  /** Edges from a top, by the top's directory (`''` for the project). */
  top: Map<string, Edge[]>;
  /** Members a node (an entry, or a top by directory) depends on through their links. */
  members: Map<LockEntry | string, Set<string>>;
}

interface Declared {
  dependencies: Readonly<Record<string, string>>;
  devDependencies?: Readonly<Record<string, string>>;
  optionalDependencies: Readonly<Record<string, string>>;
  peerDependencies: Readonly<Record<string, string>>;
  peerDependenciesMeta?: Readonly<Record<string, { optional?: boolean }>>;
}

/** What each dependency list of a top or an entry adds: name and whether it is optional. */
function declaredEdges(
  declared: Declared,
  peerOptionalFromMeta: boolean,
): { name: string; optional: boolean }[] {
  const out: { name: string; optional: boolean }[] = [];
  for (const name of Object.keys(declared.dependencies))
    if (!(name in declared.optionalDependencies))
      out.push({ name, optional: false });
  for (const name of Object.keys(declared.devDependencies ?? {}))
    out.push({ name, optional: false });
  for (const name of Object.keys(declared.optionalDependencies))
    out.push({ name, optional: true });
  for (const name of Object.keys(declared.peerDependencies))
    out.push({
      name,
      optional:
        peerOptionalFromMeta &&
        declared.peerDependenciesMeta?.[name]?.optional === true,
    });
  return out;
}

function push<K>(map: Map<K, Edge[]>, key: K, edge: Edge): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [edge]);
  else list.push(edge);
}

export function buildGraph(
  tree: PackageLockTree,
  all: readonly LockEntry[],
  byPath: ReadonlyMap<string, LockEntry>,
): LockGraph {
  const graph: LockGraph = {
    into: new Map(),
    out: new Map(),
    top: new Map(),
    members: new Map(),
  };
  const linkedMember = new Map(
    (tree.workspace?.links ?? []).map((link) => [link.path, link.dir]),
  );
  const connect = (
    from: LockEntry | string,
    member: string,
    chain: readonly string[],
    name: string,
    optional: boolean,
  ): void => {
    const to = resolveFromChain(byPath, chain, name, member);
    if (to === undefined) {
      const dir = linkedMember.get(`node_modules/${name}`);
      if (dir !== undefined)
        graph.members.set(
          from,
          (graph.members.get(from) ?? new Set()).add(dir),
        );
      return;
    }
    const edge: Edge = {
      from: typeof from === 'string' ? null : from,
      to,
      optional,
    };
    push(graph.into, to, edge);
    if (typeof from === 'string') push(graph.top, from, edge);
    else push(graph.out, from, edge);
  };

  const root = tree.root;
  if (root !== undefined)
    // The project's own peers are required: its manifest has no
    // `peerDependenciesMeta` in the lock to say otherwise.
    for (const { name, optional } of declaredEdges(root, false))
      connect('', '', [], name, optional);
  for (const member of tree.workspace?.members ?? [])
    for (const { name, optional } of declaredEdges(member, true))
      connect(member.dir, member.dir, [], name, optional);
  for (const entry of all)
    for (const { name, optional } of declaredEdges(entry, true))
      connect(entry, entry.member, entry.chain, name, optional);
  return graph;
}

/**
 * What npm drops when an optional package cannot be installed (arborist's
 * `optionalSet`): the package, the packages above it that need it outright,
 * and whatever is then needed only from inside that set.
 */
export function optionalSet(
  failed: LockEntry,
  graph: Pick<LockGraph, 'into' | 'out'>,
): Set<LockEntry> {
  const { into, out } = graph;
  const set = new Set<LockEntry>([failed]);
  for (const node of set)
    for (const edge of into.get(node) ?? [])
      if (!edge.optional && edge.from !== null) set.add(edge.from);
  const deps = new Set(set);
  for (const node of deps)
    for (const edge of out.get(node) ?? [])
      if (!edge.optional) deps.add(edge.to);
  let changed = true;
  while (changed && deps.size > 0) {
    changed = false;
    for (const dep of deps) {
      const outside = (into.get(dep) ?? []).some(
        (edge) =>
          !edge.optional && (edge.from === null || !deps.has(edge.from)),
      );
      if (outside) {
        deps.delete(dep);
        changed = true;
      }
    }
  }
  return deps;
}

/** What a set of tops needs: the packages, and the members reached through links. */
export interface Reach {
  entries: Set<LockEntry>;
  members: Set<string>;
}

/**
 * Everything the tops in `starts` depend on, transitively, by any kind of edge.
 * With `followMembers`, a member a node depends on joins the walk, and so do
 * its own dependencies.
 */
export function reachFrom(
  graph: LockGraph,
  starts: readonly string[],
  followMembers: boolean,
): Reach {
  const reach: Reach = { entries: new Set(), members: new Set() };
  const seenTops = new Set<string>();
  const pending: (LockEntry | string)[] = [...starts];
  while (pending.length > 0) {
    const node = pending.pop()!;
    let edges: readonly Edge[] | undefined;
    if (typeof node === 'string') {
      if (seenTops.has(node)) continue;
      seenTops.add(node);
      edges = graph.top.get(node);
    } else edges = graph.out.get(node);
    for (const edge of edges ?? [])
      if (!reach.entries.has(edge.to)) {
        reach.entries.add(edge.to);
        pending.push(edge.to);
      }
    // The project's own edges to a member's name are workspace edges, which a
    // selection by member or by root never follows.
    if (followMembers && node !== '')
      for (const dir of graph.members.get(node) ?? [])
        if (!reach.members.has(dir)) {
          reach.members.add(dir);
          pending.push(dir);
        }
  }
  return reach;
}
