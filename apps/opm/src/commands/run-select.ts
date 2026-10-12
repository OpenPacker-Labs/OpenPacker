/**
 * Which workspace members a run touches, in what order, and how many at once
 * (ADR 0053). The workspace model is wave one's (ADR 0049): discovery reads
 * the declaration without following a link, `selectMembers` is pnpm's
 * `--filter`, `selectNpmWorkspaces` is npm's `-w`, `topologicalOrder` orders by
 * the dependency graph. This file only chooses between them and turns the
 * answer into a plan.
 *
 * The library is loaded here, on first use: a run without a selection option
 * never reaches this file (ADR 0047 §19).
 */
import { availableParallelism } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { realpath } from 'node:fs/promises';
import type { WorkspaceError, WorkspaceGraph } from '@openpacker/adapter-core';
import type { RunContext } from './run-context.js';
import { RunError } from './run-error.js';
import { memberLabel, type OutputMode } from './run-output.js';
import type { SelectOptions } from './run-select-args.js';

export interface PlannedMember {
  /** Relative to the workspace root, `/`-separated; `''` is the root. */
  dir: string;
  /** The absolute directory. */
  abs: string;
  name: string | undefined;
  /** What a line of output is prefixed with. */
  label: string;
  /** Directories of the members this one waits for. */
  after: string[];
}

export interface WorkspacePlan {
  /** The canonical workspace root. */
  root: string;
  /** The members, in the order they are started. */
  members: PlannedMember[];
  /** How many run at once. */
  limit: number;
  mode: OutputMode;
  /** Said once on stderr before anything runs. */
  warnings: string[];
}

const NO_WORKSPACE =
  'declares no workspace (no pnpm-workspace.yaml, and no "workspaces" in package.json), so there are no members to select; run from the workspace root, or name it with --path';

/** pnpm's rule: a positive number is itself, 0 is every processor, a negative one that many fewer. */
export function workspaceConcurrency(
  requested: number | undefined,
  processors: number,
  fallback: number,
): number {
  if (requested === undefined) return fallback;
  if (requested > 0) return requested;
  return Math.max(1, processors + requested);
}

function cwdInside(root: string, cwd: string): string {
  const rel = relative(root, cwd);
  return rel.startsWith('..') || isAbsolute(rel)
    ? ''
    : rel.split(sep).join('/');
}

/** A workspace refusal as a run error, with the exit code its kind deserves. */
function asRunError(error: WorkspaceError): RunError {
  switch (error.code) {
    case 'WORKSPACE_FILTER_NO_MATCH':
      return new RunError('NOT_FOUND', error.message);
    case 'WORKSPACE_FILTER_INVALID':
    case 'WORKSPACE_FILTER_UNSUPPORTED':
      return new RunError('USAGE', error.message);
    case 'WORKSPACE_SYMLINK':
    case 'WORKSPACE_PATH_UNSAFE':
      return new RunError('UNSAFE_PATH', error.message);
    default:
      return new RunError('INVALID_MANIFEST', error.message);
  }
}

type Core = typeof import('@openpacker/adapter-core');

function chooseDirs(
  core: Core,
  graph: WorkspaceGraph,
  select: SelectOptions,
  cwd: string,
): string[] {
  if (select.workspaceRoot) {
    const root = graph.members.find((member) => member.root);
    if (root === undefined)
      throw new RunError(
        'NOT_FOUND',
        'The workspace root has no package.json, so there is nothing to run in it',
      );
    return [root.dir];
  }
  if (select.workspaces.length > 0 || select.allWorkspaces)
    return [
      ...core.selectNpmWorkspaces(graph, select.workspaces, {
        cwd,
        includeRoot: select.includeRoot,
      }),
    ];
  const limits = core.resolveWorkspaceLimits();
  const selectors = select.filters.map((filter) =>
    core.parseFilter(filter, { cwd, limits }),
  );
  return [
    ...core.selectMembers(graph, selectors, {
      excludeRoot: !select.includeRoot,
    }).selected,
  ];
}

interface Ordering {
  dirs: string[];
  after: Map<string, string[]>;
  warnings: string[];
}

function orderDirs(
  core: Core,
  graph: WorkspaceGraph,
  select: SelectOptions,
  chosen: readonly string[],
): Ordering {
  const after = new Map<string, string[]>(chosen.map((dir) => [dir, []]));
  if (
    select.parallel ||
    select.noSort ||
    select.workspaces.length > 0 ||
    select.allWorkspaces
  )
    return { dirs: [...chosen], after, warnings: [] };
  const order = core.topologicalOrder(graph, {
    cycles: 'tolerate',
    among: chosen,
  });
  const cycleOf = new Map<string, number>();
  order.cycles.forEach((cycle, at) => {
    for (const dir of cycle.members) cycleOf.set(dir, at);
  });
  const selected = new Set(chosen);
  for (const dir of chosen)
    for (const edge of graph.outgoing.get(dir) ?? []) {
      if (!selected.has(edge.to)) continue;
      const sameCycle =
        cycleOf.has(dir) && cycleOf.get(dir) === cycleOf.get(edge.to);
      if (sameCycle) continue;
      // `--reverse`: a member waits for the members that depend on it.
      const [waiter, awaited] = select.reverse
        ? [edge.to, dir]
        : [dir, edge.to];
      const list = after.get(waiter) ?? [];
      if (!list.includes(awaited)) list.push(awaited);
      after.set(waiter, list);
    }
  const dirs = select.reverse ? [...order.order].reverse() : [...order.order];
  const names = (dir: string) => graph.index.byDir.get(dir)?.name ?? dir;
  const warnings = order.cycles.map(
    (cycle) =>
      `opm: warning: cyclic workspace dependencies ${cycle.path.map(names).join(' -> ')}${cycle.runtime ? '' : ' (closed by devDependencies)'}; these members run together`,
  );
  return { dirs, after, warnings };
}

/** Choose the members of a workspace for `select` and put them in order. */
export async function planWorkspace(
  select: SelectOptions,
  projectRoot: string,
  usesPath: boolean,
  cwd: string,
  context: RunContext,
): Promise<WorkspacePlan> {
  const core = await import('@openpacker/adapter-core');
  const project = await import('@openpacker/opm-project');
  try {
    const root = await realpath(projectRoot);
    const discovery = await project.discoverWorkspace(root);
    if (discovery === undefined)
      throw new RunError('USAGE', `${root} ${NO_WORKSPACE}`);
    const graph = project.graphOfWorkspace(discovery);
    const here = usesPath ? '' : cwdInside(root, await realpath(cwd));
    const chosen = chooseDirs(core, graph, select, here);
    if (chosen.length === 0)
      throw new RunError(
        'NOT_FOUND',
        `The workspace at ${root} has no member to run in${select.includeRoot ? '' : ' (the root is left out unless --include-workspace-root)'}`,
      );
    const ordering = orderDirs(core, graph, select, chosen);
    const byDir = new Map(graph.members.map((member) => [member.dir, member]));
    const processors = context.parallelism ?? availableParallelism();
    const npmStyle = select.workspaces.length > 0 || select.allWorkspaces;
    const limit = select.parallel
      ? Infinity
      : workspaceConcurrency(
          select.concurrency,
          processors,
          npmStyle ? 1 : Math.min(4, processors),
        );
    return {
      root,
      members: ordering.dirs.map((dir) => {
        const member = byDir.get(dir)!;
        return {
          dir,
          abs: dir === '' ? root : join(root, ...dir.split('/')),
          name: member.name,
          label: memberLabel(member),
          after: ordering.after.get(dir) ?? [],
        };
      }),
      limit,
      mode:
        select.stream || select.parallel || limit === 1 ? 'stream' : 'group',
      warnings: ordering.warnings,
    };
  } catch (error) {
    if (error instanceof core.WorkspaceError) throw asRunError(error);
    throw error;
  }
}
