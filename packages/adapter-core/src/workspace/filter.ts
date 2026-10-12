import { WorkspaceError } from './errors.js';
import { globMatches } from './glob.js';
import type { WorkspaceEdge, WorkspaceGraph } from './graph.js';
import { DEPENDENCY_FIELDS, type DependencyField } from './manifest.js';
import type { WorkspaceMember } from './members.js';
import { resolveRelativeDirectory } from './spec.js';
import { starMatches, type FilterSelector } from './filter-parse.js';

export interface SelectOptions {
  /** Which dependency lists `...` follows. All four when absent, as pnpm does. */
  readonly fields?: readonly DependencyField[];
  /** Succeed with an empty selection instead of refusing a selector that matches nothing. */
  readonly allowEmpty?: boolean;
  /** Leave the workspace root out of the result, as `pnpm -r` does unless told otherwise. */
  readonly excludeRoot?: boolean;
}

export interface Selection {
  /** The selected members' directories, in the workspace's member order. */
  readonly selected: readonly string[];
  /** Selectors that matched no member. */
  readonly unmatched: readonly string[];
}

function inside(parent: string, child: string): boolean {
  return parent === '' || child === parent || child.startsWith(`${parent}/`);
}

function byName(members: readonly WorkspaceMember[], pattern: string) {
  const hit = (pool: string) =>
    members.filter((m) => m.name !== undefined && starMatches(pool, m.name));
  const found = hit(pattern);
  if (found.length > 0 || pattern.startsWith('@') || pattern.includes('/'))
    return found;
  // pnpm: a bare name that matches nothing may be the one unscoped spelling of
  // a scoped package, when exactly one scope has it.
  const scoped = hit(`@*/${pattern}`);
  return scoped.length === 1 ? scoped : [];
}

function entryMembers(
  graph: WorkspaceGraph,
  selector: FilterSelector,
): readonly string[] {
  let pool: readonly WorkspaceMember[] = graph.members;
  const where = selector.directory;
  if (where !== undefined)
    pool = pool.filter((member) =>
      where.kind === 'subtree'
        ? inside(where.dir, member.dir)
        : where.alternatives.some((glob) =>
            globMatches(glob, member.dir === '' ? [] : member.dir.split('/')),
          ),
    );
  if (selector.name !== undefined) pool = byName(pool, selector.name);
  return pool.map((member) => member.dir);
}

function walk(
  starts: readonly string[],
  next: (dir: string) => readonly string[],
  includeStarts: boolean,
): Set<string> {
  const reached = new Set<string>();
  const stack: { dir: string; counted: boolean }[] = starts.map((dir) => ({
    dir,
    counted: includeStarts,
  }));
  const expanded = new Set<string>();
  while (stack.length > 0) {
    const { dir, counted } = stack.pop()!;
    if (counted) reached.add(dir);
    if (expanded.has(dir)) continue;
    expanded.add(dir);
    for (const further of next(dir))
      stack.push({ dir: further, counted: true });
  }
  return reached;
}

/**
 * The members a list of `--filter` selectors selects, as pnpm decides it: the
 * union of the selectors that add, less the union of those that take away
 * (`!`); with no selector that adds, every member is the start. A selector
 * that matches no member is an error, unless `allowEmpty`; an excluding one
 * that matches nothing never is.
 */
export function selectMembers(
  graph: WorkspaceGraph,
  selectors: readonly FilterSelector[],
  options: SelectOptions = {},
): Selection {
  const fields = options.fields ?? DEPENDENCY_FIELDS;
  const usable = (edges: readonly WorkspaceEdge[] | undefined) =>
    (edges ?? []).filter((edge) => fields.includes(edge.field));
  const dependencies = (dir: string) =>
    usable(graph.outgoing.get(dir)).map((edge) => edge.to);
  const dependents = (dir: string) =>
    usable(graph.incoming.get(dir)).map((edge) => edge.from);
  const unmatched: string[] = [];
  const reachFor = (selector: FilterSelector): Set<string> => {
    const entries = entryMembers(graph, selector);
    if (entries.length === 0) {
      unmatched.push(selector.source);
      return new Set();
    }
    if (!selector.includeDependencies && !selector.includeDependents)
      return new Set(entries);
    const picked = new Set<string>();
    const includeSelf = !selector.excludeSelf;
    if (selector.includeDependencies)
      for (const dir of walk(entries, dependencies, includeSelf))
        picked.add(dir);
    if (selector.includeDependents) {
      const above = walk(entries, dependents, includeSelf);
      for (const dir of above) picked.add(dir);
      if (selector.includeDependencies)
        for (const dir of walk([...above], dependencies, false))
          picked.add(dir);
    }
    return picked;
  };
  const added = new Set<string>();
  const taken = new Set<string>();
  const adding = selectors.filter((selector) => !selector.exclude);
  for (const selector of selectors) {
    const reached = reachFor(selector);
    for (const dir of reached) (selector.exclude ? taken : added).add(dir);
  }
  if (adding.length === 0)
    for (const member of graph.members) added.add(member.dir);
  const refused = unmatched.filter((source) =>
    adding.some((selector) => selector.source === source),
  );
  if (refused.length > 0 && options.allowEmpty !== true)
    throw new WorkspaceError(
      'WORKSPACE_FILTER_NO_MATCH',
      `No workspace member matches the filter ${refused.map((s) => JSON.stringify(s)).join(', ')}`,
      refused,
    );
  const selected = graph.members
    .filter((member) => added.has(member.dir) && !taken.has(member.dir))
    .filter((member) => !(options.excludeRoot === true && member.root))
    .map((member) => member.dir);
  if (selected.length === 0 && adding.length > 0 && options.allowEmpty !== true)
    throw new WorkspaceError(
      'WORKSPACE_FILTER_NO_MATCH',
      `The filters ${adding.map((s) => JSON.stringify(s.source)).join(', ')} select no workspace member once the exclusions are applied`,
      adding.map((s) => s.source),
    );
  return { selected, unmatched };
}

export interface NpmWorkspaceOptions {
  /** The directory the command ran in, relative to the workspace root. */
  readonly cwd: string;
  /** Keep the root when it matches, as `--include-workspace-root` does. */
  readonly includeRoot?: boolean;
}

/**
 * What `npm -w <arg>` selects: the member of that name, the member in that
 * directory, or every member one level below that directory. npm refuses a
 * list that selects nothing ("No workspaces found"), and so does this.
 */
export function selectNpmWorkspaces(
  graph: WorkspaceGraph,
  args: readonly string[],
  options: NpmWorkspaceOptions,
): readonly string[] {
  const members = graph.members.filter(
    (member) => !member.root || options.includeRoot === true,
  );
  if (args.length === 0) return members.map((member) => member.dir);
  const chosen = new Set<string>();
  for (const arg of args) {
    const dir = resolveRelativeDirectory(options.cwd, arg);
    for (const member of members) {
      const parent = member.dir.includes('/')
        ? member.dir.slice(0, member.dir.lastIndexOf('/'))
        : '';
      if (
        member.name === arg ||
        (dir !== undefined && (member.dir === dir || parent === dir))
      )
        chosen.add(member.dir);
    }
  }
  if (chosen.size === 0)
    throw new WorkspaceError(
      'WORKSPACE_FILTER_NO_MATCH',
      `No workspaces found: ${args.map((arg) => `--workspace=${arg}`).join(' ')}`,
      [...args],
    );
  return members.filter((m) => chosen.has(m.dir)).map((m) => m.dir);
}
