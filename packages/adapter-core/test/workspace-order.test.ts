import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  DEPENDENCY_FIELDS,
  WorkspaceError,
  topologicalOrder,
  type DependencyField,
  type WorkspaceGraph,
} from '../src/index.js';
import { codeOf, type Tree } from './workspace-helpers.js';
import { graphOf } from './workspace-graph-helpers.js';

const name = (at: number) => `n${at}`;
const dir = (at: number) => `packages/${name(at)}`;

/** Members n0..n(count-1); each edge [from, to, list] is `from` listing `to` as workspace:* in `list`. */
function treeOf(
  count: number,
  edges: readonly (readonly [number, number, DependencyField])[],
): Tree {
  const tree: Tree = { '': { name: 'root' } };
  for (let at = 0; at < count; at += 1) tree[dir(at)] = { name: name(at) };
  for (const [from, to, field] of edges) {
    const manifest = tree[dir(from)] as Record<string, Record<string, string>>;
    manifest[field] = { ...manifest[field], [name(to)]: 'workspace:*' };
  }
  return tree;
}

describe('dependency order', () => {
  it('puts a dependency before its dependent, and orders a diamond in layers', () => {
    const graph = graphOf(
      treeOf(4, [
        [0, 1, 'dependencies'],
        [0, 2, 'dependencies'],
        [1, 3, 'dependencies'],
        [2, 3, 'devDependencies'],
      ]),
    );
    const result = topologicalOrder(graph, { cycles: 'error' });
    expect(result.chunks).toEqual([['', dir(3)], [dir(1), dir(2)], [dir(0)]]);
    expect(result.order).toEqual(['', dir(3), dir(1), dir(2), dir(0)]);
    expect(result.cycles).toEqual([]);
  });

  it('orders only the members asked for, and ignores a dependency outside them', () => {
    const graph = graphOf(
      treeOf(3, [
        [0, 1, 'dependencies'],
        [1, 2, 'dependencies'],
      ]),
    );
    expect(
      topologicalOrder(graph, { cycles: 'error', among: [dir(0), dir(2)] })
        .order,
    ).toEqual([dir(0), dir(2)]);
  });

  it('ignores a member that lists itself, as pnpm does', () => {
    const graph = graphOf(treeOf(2, [[0, 0, 'devDependencies']]));
    expect(topologicalOrder(graph, { cycles: 'error' }).cycles).toEqual([]);
  });

  it('orders a chain of thousands without recursing', () => {
    const edges = Array.from(
      { length: 3999 },
      (_, at) => [at + 1, at, 'dependencies'] as const,
    );
    const started = performance.now();
    const result = topologicalOrder(graphOf(treeOf(4000, edges)), {
      cycles: 'error',
    });
    expect(result.chunks).toHaveLength(4000);
    expect(result.order.indexOf(dir(0))).toBeLessThan(
      result.order.indexOf(dir(3999)),
    );
    expect(performance.now() - started).toBeLessThan(5000);
  });
});

describe('cycles', () => {
  const ring = treeOf(3, [
    [0, 1, 'dependencies'],
    [1, 2, 'dependencies'],
    [2, 0, 'dependencies'],
    [3 - 1, 1, 'dependencies'],
  ]);

  it('is an error that names the members and one way round, when asked', () => {
    const run = () => topologicalOrder(graphOf(ring), { cycles: 'error' });
    expect(codeOf(run)).toBe('WORKSPACE_CYCLE');
    expect(run).toThrowError(
      /There are cyclic workspace dependencies: n0 \(packages\/n0\) -> n1 \(packages\/n1\) -> n2 \(packages\/n2\) -> n0 \(packages\/n0\)/u,
    );
    try {
      run();
    } catch (error) {
      expect((error as WorkspaceError).subjects).toEqual([
        dir(0),
        dir(1),
        dir(2),
      ]);
    }
  });

  it('is reported and ordered as one group, when tolerated (pnpm warns and goes on)', () => {
    const result = topologicalOrder(graphOf(ring), { cycles: 'tolerate' });
    expect(result.cycles).toEqual([
      {
        members: [dir(0), dir(1), dir(2)],
        path: [dir(0), dir(1), dir(2), dir(0)],
        runtime: true,
      },
    ]);
    expect(result.chunks).toEqual([['', dir(0), dir(1), dir(2)]]);
  });

  it('is legal when only devDependencies close it, and says so', () => {
    const tree = treeOf(2, [
      [0, 1, 'dependencies'],
      [1, 0, 'devDependencies'],
    ]);
    const graph = graphOf(tree);
    const tolerated = topologicalOrder(graph, { cycles: 'tolerate' });
    expect(tolerated.cycles.map((c) => c.runtime)).toEqual([false]);
    // Ordering by what is needed at run time does not see it at all.
    const runtime = topologicalOrder(graph, {
      cycles: 'error',
      fields: ['dependencies', 'optionalDependencies', 'peerDependencies'],
    });
    expect(runtime.cycles).toEqual([]);
    expect(runtime.order.indexOf(dir(1))).toBeLessThan(
      runtime.order.indexOf(dir(0)),
    );
  });

  it('lists every cycle, each with its way round', () => {
    const graph = graphOf(
      treeOf(4, [
        [0, 1, 'dependencies'],
        [1, 0, 'dependencies'],
        [2, 3, 'dependencies'],
        [3, 2, 'peerDependencies'],
      ]),
    );
    const { cycles } = topologicalOrder(graph, { cycles: 'tolerate' });
    expect(cycles.map((c) => c.members)).toEqual([
      [dir(0), dir(1)],
      [dir(2), dir(3)],
    ]);
    expect(cycles.every((c) => c.runtime)).toBe(true);
    expect(() => topologicalOrder(graph, { cycles: 'error' })).toThrowError(
      /n0 \(packages\/n0\) -> n1 \(packages\/n1\) -> n0 \(packages\/n0\); n2 \(packages\/n2\) -> n3 \(packages\/n3\) -> n2/u,
    );
  });

  it('puts what depends on a cycle after the cycle and what the cycle depends on before it', () => {
    const graph = graphOf(
      treeOf(4, [
        [0, 1, 'dependencies'],
        [1, 0, 'dependencies'],
        [1, 2, 'dependencies'],
        [3, 0, 'dependencies'],
      ]),
    );
    const { chunks } = topologicalOrder(graph, { cycles: 'tolerate' });
    expect(chunks).toEqual([['', dir(2)], [dir(0), dir(1)], [dir(3)]]);
  });
});

/** Nodes 0..n-1 and edges between them, any field. */
const graphArbitrary = fc.integer({ min: 1, max: 8 }).chain((count) =>
  fc.record({
    count: fc.constant(count),
    edges: fc.array(
      fc.tuple(
        fc.integer({ min: 0, max: count - 1 }),
        fc.integer({ min: 0, max: count - 1 }),
        fc.constantFrom(...DEPENDENCY_FIELDS),
      ),
      { maxLength: 24 },
    ),
  }),
);

/** The reachability closure, by repeated squaring: the oracle for which nodes share a cycle. */
function reachability(
  graph: WorkspaceGraph,
  fields: readonly DependencyField[],
) {
  const dirs = graph.members.map((m) => m.dir);
  const reach = new Map(dirs.map((d) => [d, new Set<string>()]));
  for (const edge of graph.edges)
    if (fields.includes(edge.field)) reach.get(edge.from)?.add(edge.to);
  for (const via of dirs)
    for (const from of dirs)
      if (reach.get(from)?.has(via))
        for (const to of reach.get(via) ?? []) reach.get(from)?.add(to);
  return reach;
}

describe('dependency order, over every small graph', () => {
  it('puts every dependency before its dependent, or in the same group when they share a cycle', () => {
    fc.assert(
      fc.property(graphArbitrary, ({ count, edges }) => {
        const graph = graphOf(treeOf(count, edges));
        const { order, chunks, cycles } = topologicalOrder(graph, {
          cycles: 'tolerate',
        });
        const at = new Map(order.map((d, i) => [d, i]));
        const chunkOf = new Map(
          chunks.flatMap((c, i) => c.map((d) => [d, i] as const)),
        );
        expect(order).toHaveLength(graph.members.length);
        expect(new Set(order).size).toBe(order.length);
        const together = (a: string, b: string) =>
          cycles.some(
            (cycle) => cycle.members.includes(a) && cycle.members.includes(b),
          );
        for (const edge of graph.edges) {
          if (together(edge.from, edge.to)) {
            expect(chunkOf.get(edge.from)).toBe(chunkOf.get(edge.to));
          } else {
            expect(at.get(edge.to)!).toBeLessThan(at.get(edge.from)!);
            expect(chunkOf.get(edge.to)!).toBeLessThan(chunkOf.get(edge.from)!);
          }
        }
      }),
      { numRuns: 400 },
    );
  });

  it('reports exactly the groups of members that depend on each other', () => {
    fc.assert(
      fc.property(graphArbitrary, ({ count, edges }) => {
        const graph = graphOf(treeOf(count, edges));
        const reach = reachability(graph, DEPENDENCY_FIELDS);
        const expected = new Set<string>();
        for (const a of graph.members)
          for (const b of graph.members)
            if (
              a.dir < b.dir &&
              reach.get(a.dir)?.has(b.dir) &&
              reach.get(b.dir)?.has(a.dir)
            )
              expected.add(`${a.dir}|${b.dir}`);
        const { cycles } = topologicalOrder(graph, { cycles: 'tolerate' });
        const reported = new Set<string>();
        for (const cycle of cycles)
          for (const a of cycle.members)
            for (const b of cycle.members) if (a < b) reported.add(`${a}|${b}`);
        expect(reported).toEqual(expected);
        expect(codeOf(() => topologicalOrder(graph, { cycles: 'error' }))).toBe(
          cycles.length > 0 ? 'WORKSPACE_CYCLE' : 'no error',
        );
      }),
      { numRuns: 400 },
    );
  });

  it('marks a cycle runtime exactly when runtime lists alone still close one', () => {
    fc.assert(
      fc.property(graphArbitrary, ({ count, edges }) => {
        const graph = graphOf(treeOf(count, edges));
        const runtime = [
          'dependencies',
          'optionalDependencies',
          'peerDependencies',
        ] as const;
        const reach = reachability(graph, runtime);
        const { cycles } = topologicalOrder(graph, { cycles: 'tolerate' });
        for (const cycle of cycles) {
          const closes = cycle.members.some((a) =>
            cycle.members.some(
              (b) => a !== b && reach.get(a)?.has(b) && reach.get(b)?.has(a),
            ),
          );
          expect(cycle.runtime).toBe(closes);
        }
      }),
      { numRuns: 400 },
    );
  });
});
