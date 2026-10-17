/**
 * Random valid pnpm-shaped placement inputs whose packages peer each other,
 * cycles included, for the placement suites (ADR 0055 §9).
 *
 * pnpm writes into an instance's key everything its subtree depends on, and a
 * dependent provides the peers of what it depends on, so a world is built
 * that way: a context picks one version of every package, an instance of a
 * package in a context is keyed by the versions of everything it reaches, and
 * an importer lists the packages it wants and, in turn, the peers of those.
 */

import type { PlaceEdge, PlaceInput, PlaceInstance } from './place-types.js';

/** A seeded source of numbers in [0, 1): one sequence per seed. */
export function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

export interface CycleSpec {
  /** Packages that may peer each other. */
  readonly packages: number;
  /** Workspace members, some of them nested in the first. */
  readonly members: number;
  /** How likely a package is to peer one that comes after it: what makes a cycle. */
  readonly cycles: number;
}

type Graph = Record<string, readonly string[]>;

/** Everything `start` reaches through `edges`, to a fixed point. */
function reached(names: readonly string[], edges: Graph): Graph {
  const out = Object.fromEntries(names.map((n) => [n, new Set(edges[n])]));
  for (let again = true; again; ) {
    again = false;
    for (const n of names)
      for (const m of out[n]!)
        for (const x of out[m]!)
          if (x !== n && !out[n]!.has(x)) {
            out[n]!.add(x);
            again = true;
          }
  }
  return Object.fromEntries(
    names.map((n) => [n, [...out[n]!].sort()]),
  ) as Graph;
}

/** A world, or `undefined` when the draw is not a valid lock (a dependent lacks a peer of what it depends on). */
export function cycleWorld(
  random: () => number,
  spec: CycleSpec,
): PlaceInput | undefined {
  const pick = <T>(list: readonly T[]): T =>
    list[Math.floor(random() * list.length)]!;
  const names = Array.from({ length: spec.packages }, (_, i) => `p${i}`);
  const versions = Object.fromEntries(
    names.map((n) => [n, random() < 0.5 ? [1, 2] : [1, 2, 3]]),
  );
  const peers: Graph = Object.fromEntries(
    names.map((n, i) => [
      n,
      names
        .filter(
          (m, j) => m !== n && random() < (j < i ? 0.18 : spec.cycles * 0.5),
        )
        .slice(0, 3),
    ]),
  );
  const deps: Graph = Object.fromEntries(
    names.map((n, i) => [
      n,
      names.filter((_, j) => j > i && random() < 0.2).slice(0, 2),
    ]),
  );
  // What a package provides to its dependents: its peers, theirs, and the
  // peers of its regular dependencies.
  const provides = reached(
    names,
    Object.fromEntries(names.map((n) => [n, [...peers[n]!, ...deps[n]!]])),
  );
  // The peers a dependent must provide for a package: its own, and those of
  // everything it peers or depends on.
  const clo = Object.fromEntries(names.map((n) => [n, new Set(peers[n])]));
  for (let again = true; again; ) {
    again = false;
    for (const n of names)
      for (const m of [...peers[n]!, ...deps[n]!]) {
        const before = clo[n]!.size;
        for (const x of clo[m]!) if (x !== n) clo[n]!.add(x);
        if (peers[n]!.includes(m)) clo[n]!.add(m);
        again ||= clo[n]!.size !== before;
      }
  }
  const closure: Graph = Object.fromEntries(
    names.map((n) => [n, [...clo[n]!]]),
  );
  const instances = new Map<string, PlaceInstance>();
  const keyOf = (n: string, context: Record<string, number>): string =>
    `${n}@${context[n]}.0.0[${provides[n]!.map((m) => `${m}=${context[m]}`).join(',')}]`;
  const build = (n: string, context: Record<string, number>): string => {
    const key = keyOf(n, context);
    if (instances.has(key)) return key;
    const edges: PlaceEdge[] = [];
    instances.set(key, {
      key,
      name: n,
      version: `${context[n]}.0.0`,
      edges,
    });
    for (const d of deps[n]!) edges.push({ as: d, to: keyOf(d, context) });
    for (const m of closure[n]!) {
      const at = edges.findIndex((edge) => edge.as === m);
      if (at >= 0) edges.splice(at, 1);
      edges.push({ as: m, to: keyOf(m, context), peer: true });
    }
    for (const edge of edges) build(edge.as, context);
    return key;
  };
  const dirs = [
    '',
    ...Array.from({ length: spec.members }, (_, m) =>
      m > 0 && random() < 0.2 ? `packages/m0/sub${m}` : `packages/m${m}`,
    ),
  ];
  const tops = dirs.map((dir) => {
    const context = Object.fromEntries(
      names.map((n) => [n, pick(versions[n]!)]),
    );
    const wanted = new Set(names.filter(() => random() < 0.45));
    for (let again = true; again; ) {
      again = false;
      for (const n of wanted)
        for (const m of closure[n]!)
          if (!wanted.has(m)) {
            wanted.add(m);
            again = true;
          }
    }
    return {
      id: dir === '' ? '.' : dir,
      dir,
      edges: [...wanted].map((n) => ({ as: n, to: build(n, context) })),
      links: [] as { as: string; memberDir: string }[],
    };
  });
  for (const top of tops) {
    const others = tops.filter(
      (o) =>
        o.dir !== '' &&
        top.dir !== '' &&
        o.dir !== top.dir &&
        !o.dir.startsWith(`${top.dir}/`) &&
        !top.dir.startsWith(`${o.dir}/`),
    );
    if (top.dir !== '' && random() < 0.25 && others.length > 0) {
      const other = pick(others);
      top.links.push({
        as: `sib${other.dir.split('/').at(-1)}`,
        memberDir: other.dir,
      });
    }
  }
  // Only what the importers reach.
  const reachable = new Set<string>();
  const pending = tops.flatMap((top) => top.edges.map((edge) => edge.to));
  for (let key = pending.pop(); key !== undefined; key = pending.pop()) {
    if (reachable.has(key)) continue;
    reachable.add(key);
    for (const edge of instances.get(key)!.edges) pending.push(edge.to);
  }
  for (const key of instances.keys())
    if (!reachable.has(key)) instances.delete(key);
  const valid = [
    ...[...instances.values()].map((i) => ({ self: i.key, edges: i.edges })),
    ...tops.map((top) => ({ self: undefined, edges: top.edges })),
  ].every(({ self, edges }) => {
    const own = new Map(edges.map((edge) => [edge.as, edge.to]));
    return edges.every(
      (edge) =>
        (edge as PlaceEdge).peer === true ||
        instances
          .get(edge.to)!
          .edges.every(
            (p) => p.peer !== true || own.get(p.as) === p.to || p.to === self,
          ),
    );
  });
  return valid ? { instances, tops } : undefined;
}
