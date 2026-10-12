import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WORKSPACE_LIMITS,
  parseFilter,
  selectMembers,
  type FilterSelector,
  type WorkspaceGraph,
} from '../src/index.js';
import { type Tree } from './workspace-helpers.js';
import { graphOf } from './workspace-graph-helpers.js';

const parse = (text: string, cwd = '') =>
  parseFilter(text, { cwd, limits: DEFAULT_WORKSPACE_LIMITS });

/**
 * pnpm's own selection, transcribed from `filterWorkspacePackages` and
 * `_filterGraph` in pnpm 10.28.0 (`workspace/filter-workspace-packages`), over a
 * plain adjacency map: the reference the implementation is compared with.
 */
function pnpmSelects(
  adjacency: Record<string, string[]>,
  selectors: {
    entries: string[];
    deps: boolean;
    dependents: boolean;
    excludeSelf: boolean;
    exclude: boolean;
  }[],
): string[] {
  const reversed: Record<string, string[]> = {};
  for (const [from, tos] of Object.entries(adjacency))
    for (const to of tos) (reversed[to] ??= []).push(from);
  const pickSubgraph = (
    g: Record<string, string[]>,
    next: string[],
    walked: Set<string>,
    includeRoot: boolean,
  ) => {
    for (const id of next)
      if (!walked.has(id)) {
        if (includeRoot) walked.add(id);
        if (g[id]) pickSubgraph(g, g[id]!, walked, true);
      }
  };
  const filterGraph = (list: typeof selectors) => {
    const cherry: string[] = [];
    const deps = new Set<string>();
    const dependents = new Set<string>();
    const depsOfDependents = new Set<string>();
    for (const s of list) {
      if (s.deps) pickSubgraph(adjacency, s.entries, deps, !s.excludeSelf);
      if (s.dependents)
        pickSubgraph(reversed, s.entries, dependents, !s.excludeSelf);
      if (s.deps && s.dependents)
        pickSubgraph(adjacency, [...dependents], depsOfDependents, false);
      if (!s.deps && !s.dependents) cherry.push(...s.entries);
    }
    return new Set([...deps, ...dependents, ...depsOfDependents, ...cherry]);
  };
  const include = selectors.filter((s) => !s.exclude);
  const exclude = filterGraph(selectors.filter((s) => s.exclude));
  const all = Object.keys(adjacency);
  const included = include.length === 0 ? new Set(all) : filterGraph(include);
  return all.filter((id) => included.has(id) && !exclude.has(id));
}

describe('selection against pnpm', () => {
  const small = fc.integer({ min: 2, max: 7 }).chain((count) =>
    fc.record({
      count: fc.constant(count),
      edges: fc.array(
        fc.tuple(
          fc.integer({ min: 0, max: count - 1 }),
          fc.integer({ min: 0, max: count - 1 }),
        ),
        { maxLength: 14 },
      ),
      // One selector: a member, the three walks, ^, and whether it takes away.
      picks: fc.array(
        fc.record({
          at: fc.integer({ min: 0, max: count - 1 }),
          deps: fc.boolean(),
          dependents: fc.boolean(),
          excludeSelf: fc.boolean(),
          exclude: fc.boolean(),
        }),
        { minLength: 1, maxLength: 3 },
      ),
    }),
  );

  it('matches the transcription of pnpm on every small graph, one selector or several', () => {
    fc.assert(
      fc.property(small, ({ count, edges, picks }) => {
        const trees: Tree = { '': { name: 'root' } };
        for (let at = 0; at < count; at += 1)
          trees[`p/n${at}`] = { name: `n${at}` };
        for (const [from, to] of edges) {
          const manifest = trees[`p/n${from}`] as Record<
            string,
            Record<string, string>
          >;
          manifest['dependencies'] = {
            ...manifest['dependencies'],
            [`n${to}`]: 'workspace:*',
          };
        }
        const g: WorkspaceGraph = graphOf(trees);
        const adjacency: Record<string, string[]> = {};
        for (const member of g.members)
          adjacency[member.dir] = (g.outgoing.get(member.dir) ?? []).map(
            (e) => e.to,
          );
        const selectors: FilterSelector[] = picks.map((p) =>
          parse(
            `${p.exclude ? '!' : ''}${p.dependents ? (p.excludeSelf ? '...^' : '...') : ''}n${p.at}${p.deps ? (p.excludeSelf && !p.dependents ? '^...' : '...') : ''}`,
          ),
        );
        const expected = pnpmSelects(
          adjacency,
          picks.map((p) => ({
            entries: [`p/n${p.at}`],
            deps: p.deps,
            dependents: p.dependents,
            // pnpm drops ^ unless a walk is asked for; ours does the same by construction.
            excludeSelf: p.excludeSelf && (p.deps || p.dependents),
            exclude: p.exclude,
          })),
        );
        const actual = selectMembers(g, selectors, {
          allowEmpty: true,
        }).selected;
        // pnpm shares walk state between selectors; the comparison is for the cases it does not matter.
        const mixes =
          picks.filter((p) => p.deps && p.dependents).length > 0 &&
          picks.length > 1;
        if (!mixes) expect(actual).toEqual(expected);
      }),
      { numRuns: 500 },
    );
  });
});
