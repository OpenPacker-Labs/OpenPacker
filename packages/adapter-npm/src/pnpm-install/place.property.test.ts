import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { planPlacement, type PlaceInput } from './place.js';
import { resolutionProblems } from './place-check.js';
import { instance, top, world } from './place-support.js';

describe('a plan always proves itself', () => {
  const names = ['n0', 'n1', 'n2', 'n3', 'n4'];
  const dirs = ['', 'a', 'a/b', 'c'];

  const graph = fc
    .record({
      edges: fc.array(
        fc.record({
          from: fc.integer({ min: 0, max: 14 }),
          to: fc.integer({ min: 0, max: 14 }),
        }),
        { maxLength: 24 },
      ),
      topEdges: fc.array(
        fc.array(fc.integer({ min: 0, max: 14 }), { maxLength: 3 }),
        { minLength: 4, maxLength: 4 },
      ),
      members: fc.subarray(['a', 'a/b', 'c'], { minLength: 0 }),
    })
    .map(({ edges, topEdges, members }): PlaceInput => {
      // 15 instances: name n(i%5) at version 1 + floor(i/5).
      const keyOf = (i: number) =>
        `${names[i % 5]}@${1 + Math.floor(i / 5)}.0.0`;
      const wanted = new Map<string, Record<string, string>>();
      for (const { from, to } of edges) {
        const edgesOf = wanted.get(keyOf(from)) ?? {};
        edgesOf[names[to % 5]!] = keyOf(to);
        wanted.set(keyOf(from), edgesOf);
      }
      const tops = ['', ...members].map((dir) => {
        const at = dirs.indexOf(dir);
        const direct: Record<string, string> = {};
        for (const i of topEdges[at] ?? []) direct[names[i % 5]!] = keyOf(i);
        return top(dir, direct);
      });
      // Only what the tops reach is in the plan.
      const reached = new Set<string>();
      const pending = tops.flatMap((t) => t.edges.map((e) => e.to));
      for (let key = pending.pop(); key !== undefined; key = pending.pop()) {
        if (reached.has(key)) continue;
        reached.add(key);
        for (const to of Object.values(wanted.get(key) ?? {})) pending.push(to);
      }
      return world(
        [...reached].map((key) => instance(key, wanted.get(key) ?? {})),
        tops,
      );
    });

  it('resolves every edge of every instance and every top, on any graph', () => {
    let refused = 0;
    fc.assert(
      fc.property(graph, (input) => {
        const placement = planPlacement(input);
        if (placement.problems.length > 0) {
          // The one thing a tree cannot hold: see the next test.
          refused += 1;
          expect(placement.problems.join('\n')).toContain('directories deep');
          return;
        }
        expect(resolutionProblems(input, placement)).toEqual([]);
      }),
      { numRuns: 400, seed: 20261012 },
    );
    // Most graphs are laid out; a few cycles are refused.
    expect(refused).toBeLessThan(200);
  });

  it('refuses packages that need each other at different versions, which no tree holds', () => {
    // a1 needs b1, b1 needs a2, a2 needs b2, b2 needs a1: each copy nested
    // beside its dependent is shadowed by the one above it, for ever.
    const input = world(
      [
        instance('a@1.0.0', { b: 'b@1.0.0' }),
        instance('b@1.0.0', { a: 'a@2.0.0' }),
        instance('a@2.0.0', { b: 'b@2.0.0' }),
        instance('b@2.0.0', { a: 'a@1.0.0' }),
      ],
      [top('', { a: 'a@1.0.0' })],
    );
    const placement = planPlacement(input);
    expect(placement.problems.join('\n')).toContain('directories deep');
    expect(placement.placed.length).toBeLessThan(200);
  });
});
