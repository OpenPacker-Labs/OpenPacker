import { readFileSync } from 'node:fs';
import type { JsonValue } from '@openpacker/contracts';
import {
  buildWorkspaceGraph,
  npmRangeEngine,
  type LinkPolicy,
  type WorkspaceGraph,
  type WorkspaceTool,
} from '../src/index.js';
import { membersOf, type Tree } from './workspace-helpers.js';

export function graphOf(
  tree: Tree,
  linkPolicy: LinkPolicy = 'workspace-protocol',
  tool: WorkspaceTool = 'pnpm',
): WorkspaceGraph {
  return buildWorkspaceGraph(membersOf(tree, tool), {
    linkPolicy,
    ranges: npmRangeEngine,
  });
}

/** A real workspace's manifests, trimmed to what the model reads. */
export interface Fixture {
  repo: string;
  tool: WorkspaceTool;
  declaration: { file: string; text?: string; workspaces?: string[] };
  root: JsonValue;
  bare: string[];
  members: Record<string, JsonValue>;
}

export function fixture(name: string): Fixture {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'),
  );
}

export function fixtureTree(source: Fixture): Tree {
  return { '': source.root, ...source.members };
}

/** The edges as `from > dependency > to` strings, for a table to compare. */
export function edgeNames(graph: WorkspaceGraph): string[] {
  const nameOf = (dir: string) => graph.index.byDir.get(dir)?.name ?? dir;
  return graph.edges.map(
    (edge) => `${nameOf(edge.from)} > ${edge.dependency} > ${nameOf(edge.to)}`,
  );
}
