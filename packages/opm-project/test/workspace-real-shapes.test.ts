import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_WORKSPACE_LIMITS,
  WorkspaceError,
  parseFilter,
  selectMembers,
  topologicalOrder,
  type WorkspaceGraph,
  type WorkspaceTool,
} from '@openpacker/adapter-core';
import type { JsonValue } from '@openpacker/contracts';
import { discoverWorkspace, graphOfWorkspace } from '../src/index.js';
import { cleanup, materialize, scratch, type Files } from './workspace-tree.js';

afterAll(cleanup);

/**
 * The four fixtures are the manifests of four real repositories, trimmed to
 * what the model reads (name, version, private, workspaces and the dependency
 * lists, the latter cut to the entries that point at a member or use a
 * workspace:, link:, file: or npm: specifier). No source is copied.
 */
interface Fixture {
  repo: string;
  tool: WorkspaceTool;
  declaration: { file: string; text?: string };
  root: JsonValue;
  bare: string[];
  members: Record<string, JsonValue>;
}

function load(name: string): Fixture {
  return JSON.parse(
    readFileSync(
      new URL(`./fixtures/workspaces/${name}.json`, import.meta.url),
      'utf8',
    ),
  );
}

async function rebuild(fixture: Fixture) {
  const files: Files = { 'package.json': fixture.root };
  if (fixture.declaration.text !== undefined)
    files['pnpm-workspace.yaml'] = fixture.declaration.text;
  for (const [dir, manifest] of Object.entries(fixture.members))
    files[`${dir}/package.json`] = manifest;
  for (const dir of fixture.bare) files[dir] = null;
  const root = await scratch(files);
  const discovery = await discoverWorkspace(root);
  if (discovery === undefined)
    throw new Error(`${fixture.repo} was not found to be a workspace`);
  return discovery;
}

const edgeCount = (graph: WorkspaceGraph) => graph.edges.length;
const targets = (graph: WorkspaceGraph) =>
  new Set(graph.edges.map((e) => e.to)).size;

describe('the four real workspaces', () => {
  it('HoBo (pnpm, 16 patterns): 792 projects, as its lock lists them', async () => {
    const fixture = load('hobo');
    const found = await rebuild(fixture);
    expect(found.tool).toBe('pnpm');
    expect(found.declaredIn).toBe('pnpm-workspace.yaml');
    expect(found.patterns).toHaveLength(16);
    // pnpm-lock.yaml has 792 importers: 791 member directories and the root.
    expect(found.members).toHaveLength(792);
    expect(found.members.map((m) => m.dir)).toEqual([
      '',
      ...Object.keys(fixture.members).sort(),
    ]);
    // Ten directories match a pattern and hold no package.json (packages/adapters, ...): not members.
    expect(fixture.bare).toHaveLength(10);
    for (const dir of fixture.bare)
      expect(found.members.map((m) => m.dir)).not.toContain(dir);
    // One member has no name, as in the real repository.
    expect(
      found.members.filter((m) => m.name === undefined).map((m) => m.dir),
    ).toEqual(['examples/convex-swaghaus']);
    expect(found.skippedLinks).toEqual([]);
  });

  it("HoBo: 375 workspace: edges; the lock's 380 add 5 that pnpm.overrides rewrites", async () => {
    const found = await rebuild(load('hobo'));
    const protocol = graphOfWorkspace(found);
    expect(protocol.linkPolicy).toBe('workspace-protocol');
    expect(edgeCount(protocol)).toBe(375);
    expect(protocol.edges.every((e) => e.specifier === 'workspace:*')).toBe(
      true,
    );
    // The five plain ranges are ts-autocode's: `"ts-autocode-grounding": "0.1.0"` and four more, which
    // the root's pnpm.overrides turns into workspace:*. Overrides are outside the model, so they appear
    // only when plain ranges link, as npm would link them.
    const ranges = graphOfWorkspace(found, 'satisfied-range');
    expect(edgeCount(ranges)).toBe(380);
    expect(
      ranges.edges
        .filter((e) => e.via === 'range')
        .map((e) => `${e.from}>${e.dependency}`),
    ).toEqual([
      'external/ts-autocode>ts-autocode-grounding',
      'external/ts-autocode>ts-autocode-harness',
      'external/ts-autocode>ts-autocode-rewrite',
      'external/ts-autocode>ts-autocode-training',
      'external/ts-autocode/packages/training>ts-autocode-rewrite',
    ]);
    // pnpm-lock.yaml: "380 link edges to 89 packages".
    expect(targets(ranges)).toBe(89);
  });

  it('HoBo: its dependency order puts every dependency first and finds the cycles the repository has', async () => {
    const graph = graphOfWorkspace(await rebuild(load('hobo')));
    const order = topologicalOrder(graph, { cycles: 'tolerate' });
    expect(order.order).toHaveLength(792);
    const at = new Map(order.order.map((dir, index) => [dir, index]));
    const together = (a: string, b: string) =>
      order.cycles.some((c) => c.members.includes(a) && c.members.includes(b));
    for (const edge of graph.edges)
      if (!together(edge.from, edge.to))
        expect(at.get(edge.to)!).toBeLessThan(at.get(edge.from)!);
    expect(order.cycles).toEqual([]);
    expect(() => topologicalOrder(graph, { cycles: 'error' })).not.toThrow();
  });

  it('HoBo: the --filter forms its scripts and CI use select what they should', async () => {
    const graph = graphOfWorkspace(await rebuild(load('hobo')));
    const select = (...filters: string[]) =>
      selectMembers(
        graph,
        filters.map((f) =>
          parseFilter(f, { cwd: '', limits: DEFAULT_WORKSPACE_LIMITS }),
        ),
      ).selected;
    const nameOf = (dir: string) => graph.index.byDir.get(dir)?.name;
    expect(select('@hobo/conformance').map(nameOf)).toEqual([
      '@hobo/conformance',
    ]);
    expect(select('hobo-site').map(nameOf)).toEqual(['hobo-site']);
    for (const filter of [
      '@hobo/mcp...',
      '@hobo/cloud...',
      '@hobo/stage-gate...',
      '@hobo/cli...',
    ]) {
      const picked = select(filter);
      expect(picked.length, filter).toBeGreaterThan(1);
      // The closure property: everything a selected member depends on is selected too.
      for (const dir of picked)
        for (const edge of graph.outgoing.get(dir) ?? [])
          expect(picked, `${filter}: ${edge.from} needs ${edge.to}`).toContain(
            edge.to,
          );
    }
    const several = select(
      '@hobo/mcp...',
      '@hobo/identity...',
      '@hobo/cloud...',
    );
    expect(several).toEqual(
      [
        ...new Set([
          ...select('@hobo/mcp...'),
          ...select('@hobo/identity...'),
          ...select('@hobo/cloud...'),
        ]),
      ].sort(
        (a, b) =>
          graph.members.findIndex((m) => m.dir === a) -
          graph.members.findIndex((m) => m.dir === b),
      ),
    );
    expect(select('./src/draft/technical-proofs').length).toBeGreaterThan(5);
    expect(select('./packages/core').map(nameOf)).toEqual(['@hobo/core']);
  });

  it('ai-bdd (pnpm): 9 importers, the 17 links its lock lists', async () => {
    const found = await rebuild(load('ai-bdd'));
    expect(found.members).toHaveLength(9);
    expect(edgeCount(graphOfWorkspace(found))).toBe(17);
  });

  it('ts-autocode (npm): 4 members and the root; npm links the 5 plain ranges they satisfy', async () => {
    const found = await rebuild(load('ts-autocode'));
    expect(found.tool).toBe('npm');
    expect(found.members.map((m) => m.dir)).toEqual([
      '',
      'packages/grounding',
      'packages/harness',
      'packages/rewrite',
      'packages/training',
    ]);
    expect(edgeCount(graphOfWorkspace(found))).toBe(5);
  });

  it('gitlang (npm): 8 members and the root; npm links the 22 plain ranges they satisfy', async () => {
    const found = await rebuild(load('gitlang'));
    expect(found.members).toHaveLength(9);
    expect(found.patterns).toEqual(['packages/*', 'apps/*']);
    expect(edgeCount(graphOfWorkspace(found))).toBe(22);
  });

  it('finds the same members however the lists are written (npm reading of a pnpm repository is not the same set)', async () => {
    // ai-bdd declares packages/*; as npm would read the same list the members are the same.
    const fixture = load('ai-bdd');
    const files: Files = {
      'package.json': {
        ...(fixture.root as object),
        workspaces: ['packages/*'],
      },
    };
    for (const [dir, manifest] of Object.entries(fixture.members))
      files[`${dir}/package.json`] = manifest;
    const asNpm = await discoverWorkspace(await scratch(files));
    expect(asNpm?.tool).toBe('npm');
    expect(asNpm?.members.map((m) => m.dir)).toEqual([
      '',
      ...Object.keys(fixture.members).sort(),
    ]);
  });
});

/**
 * Both tools were run over one tree with a list of patterns (see
 * packages/adapter-core/test/fixtures/workspace-glob-oracle.json); the model,
 * reading real directories, must select what each selected.
 */
interface Battery {
  manifests: string[];
  bare: string[];
  cases: { patterns: string[]; pnpm: string[]; npm: string[] }[];
}

const battery: Battery = JSON.parse(
  readFileSync(
    new URL(
      '../../adapter-core/test/fixtures/workspace-glob-oracle.json',
      import.meta.url,
    ),
    'utf8',
  ),
);

const REFUSED = new Set([
  '["/packages/*"]|pnpm',
  '["packages/*","!/packages/b"]|pnpm',
  '["packages/*","!!packages/b"]|pnpm',
  '["packages/./a"]|pnpm',
  '["packages/./a"]|npm',
  '["./packages/./a"]|pnpm',
  '["./packages/./a"]|npm',
  '["packages/a/."]|pnpm',
  '["packages/a/."]|npm',
  '["packages/*/."]|pnpm',
  '["packages/*/."]|npm',
]);

describe('patterns over real directories, against the tools', () => {
  let tree: string | undefined;
  const files = async (): Promise<string> => {
    if (tree === undefined) {
      const manifests: Files = {};
      battery.manifests.forEach((dir, at) => {
        manifests[`${dir}${dir === '' ? '' : '/'}package.json`] = {
          name: `m${at}`,
        };
      });
      for (const dir of battery.bare) manifests[dir] = null;
      tree = await scratch(manifests);
    }
    return tree;
  };

  for (const tool of ['pnpm', 'npm'] as const)
    it(`selects what ${tool} selects, for ${battery.cases.length} pattern lists`, async () => {
      const root = await files();
      const failures: string[] = [];
      for (const entry of battery.cases) {
        const key = `${JSON.stringify(entry.patterns)}|${tool}`;
        const declaration: Files =
          tool === 'pnpm'
            ? {
                'pnpm-workspace.yaml': `packages: ${JSON.stringify(entry.patterns)}\n`,
                'package.json': { name: 'm0' },
              }
            : { 'package.json': { name: 'm0', workspaces: entry.patterns } };
        await materialize(root, declaration);
        if (tool === 'npm')
          await materialize(root, { 'pnpm-workspace.yaml': '' });
        let actual: string | undefined;
        try {
          const found = await discoverWorkspace(root, { tool });
          actual = JSON.stringify((found?.members ?? []).map((m) => m.dir));
        } catch (error) {
          if (!(error instanceof WorkspaceError)) throw error;
          if (REFUSED.has(key)) continue;
          failures.push(`${key} was refused: ${error.message}`);
          continue;
        }
        if (REFUSED.has(key)) {
          failures.push(`${key} should have been refused`);
          continue;
        }
        // npm never lists the root as a workspace; the model keeps it as the project.
        const expected = JSON.stringify(
          tool === 'npm' ? ['', ...entry.npm].sort() : [...entry.pnpm].sort(),
        );
        if (actual !== expected)
          failures.push(`${key}: expected ${expected}, found ${actual}`);
      }
      expect(failures).toEqual([]);
    });
});
