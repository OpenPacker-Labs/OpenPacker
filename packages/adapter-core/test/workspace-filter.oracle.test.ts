import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WORKSPACE_LIMITS,
  WorkspaceError,
  parseFilter,
  selectMembers,
} from '../src/index.js';
import { type Tree } from './workspace-helpers.js';
import { graphOf } from './workspace-graph-helpers.js';

/**
 * workspace-filter-oracle.json holds what the real pnpm 10.28.0 command line
 * (`pnpm --filter=... ls`) selected in one workspace, for every selector form
 * in test/fixtures/workspace-oracle/filter-battery.mjs, from the root and from
 * directories below it, with and without `legacy-dir-filtering`. The model
 * reads the same selectors over the same members and must select the same
 * directories. Regenerate it with test/fixtures/workspace-oracle/README.md.
 */
interface Case {
  cwd: string;
  filters: string[];
  legacy: boolean;
  selected?: string[];
  error?: string;
}

const oracle: { members: Tree; cases: Case[] } = JSON.parse(
  readFileSync(
    new URL('./fixtures/workspace-filter-oracle.json', import.meta.url),
    'utf8',
  ),
);

const graph = graphOf(oracle.members);

type Outcome = { selected: string[] } | { refused: WorkspaceError };

function modelSelects(entry: Case): Outcome {
  try {
    const selectors = entry.filters.map((filter) =>
      parseFilter(filter, {
        cwd: entry.cwd,
        limits: DEFAULT_WORKSPACE_LIMITS,
        legacyDirFiltering: entry.legacy,
      }),
    );
    return {
      selected: [
        ...selectMembers(graph, selectors, { allowEmpty: true }).selected,
      ].sort(),
    };
  } catch (error) {
    if (error instanceof WorkspaceError) return { refused: error };
    throw error;
  }
}

/**
 * Selectors the model refuses on purpose, and what pnpm does with them. The
 * first two are refusals where pnpm selects nothing; the last two are syntax
 * pnpm's matcher reads and the model's does not.
 */
const SYNTAX = new Set([
  './packages/[ab]',
  '{./packages/[ab]}',
  './packages/@(a|b)',
  '{./packages/@(a|b)}',
]);
const BRACES = new Set(['./packages/{a,b}']);

const label = (entry: Case) =>
  `${entry.legacy ? 'legacy: ' : ''}${entry.filters.join(' ')}${entry.cwd === '' ? '' : `  (from ${entry.cwd})`}`;

describe('the filters the model reads, against the pnpm command line', () => {
  it('holds a result for every case', () => {
    expect(oracle.cases.length).toBeGreaterThan(400);
    expect(oracle.cases.filter((entry) => entry.error !== undefined)).toEqual(
      [],
    );
  });

  for (const entry of oracle.cases) {
    it(label(entry), () => {
      const outcome = modelSelects(entry);
      if ('selected' in outcome) {
        expect(outcome.selected).toEqual([...(entry.selected ?? [])].sort());
        return;
      }
      const { code, message } = outcome.refused;
      const [filter] = entry.filters;
      if (BRACES.has(filter ?? '')) {
        expect(code).toBe('WORKSPACE_FILTER_INVALID');
        expect(message).toContain('uses braces in a directory selector');
      } else if (SYNTAX.has(filter ?? '')) {
        // pnpm reads a character class or an extglob; the model says it cannot.
        expect(code).toBe('WORKSPACE_FILTER_UNSUPPORTED');
        expect(entry.legacy).toBe(false);
        expect(entry.selected).toEqual(['packages/a', 'packages/b']);
      } else {
        // A path that leaves the workspace. pnpm matches nothing, or, reading a
        // path as "this directory and below", everything under an ancestor of
        // the root; the model says that it does not follow the path out.
        expect(code).toBe('WORKSPACE_FILTER_INVALID');
        expect(message).toContain('leaves the workspace root');
        const everything = graph.members.map((member) => member.dir).sort();
        expect(entry.legacy ? [[], everything] : [[]]).toContainEqual(
          entry.selected,
        );
      }
    });
  }
});
