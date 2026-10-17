/**
 * Which part of a workspace a frozen install installs, and what it links.
 *
 * `npm ci` with no workspace flag installs the whole lock. `--workspace` (`-w`)
 * installs the named members and what they need: the link to each, the
 * packages their dependency lists reach, and the members those depend on. The
 * project's own dependencies come along only with `--include-workspace-root`.
 * `--workspaces=false` is the opposite selection: the project's own
 * dependencies, with no member and no link to one. The rules are arborist's
 * (`workspaceDependencySet`, and the filter `Diff.calculate` applies); the
 * graph walked is the lock's.
 */

import type {
  FrozenLockWorkspace,
  FrozenWorkspaceScope,
} from '@openpacker/adapter-core';
import { reachFrom, type LockGraph } from './frozen-graph.js';
import { invalid } from './lock-json.js';
import type { LockEntry, PackageLockTree } from './lock-tree.js';
import type { LockMember } from './lock-workspace.js';

/** The part of the lock that is installed. */
export interface WorkspaceSelection {
  /** The packages in scope; undefined when every package is. */
  entries: ReadonlySet<LockEntry> | undefined;
  /** The members that are installed, linked and shimmed. */
  members: readonly LockMember[];
}

export function scopeOfWorkspace(
  tree: PackageLockTree,
  graph: LockGraph,
  scope: FrozenWorkspaceScope = { kind: 'all' },
): WorkspaceSelection {
  const members = tree.workspace?.members ?? [];
  if (scope.kind === 'all') return { entries: undefined, members };
  if (scope.kind === 'root')
    return { entries: reachFrom(graph, [''], false).entries, members: [] };
  const known = new Set(members.map((member) => member.dir));
  const unknown = scope.dirs.filter((dir) => !known.has(dir));
  if (unknown.length > 0)
    throw invalid(
      `The workspace selection names ${unknown.join(', ')}, which ${unknown.length === 1 ? 'is' : 'are'} not a member of the lock`,
    );
  const reach = reachFrom(
    graph,
    [...scope.dirs, ...(scope.includeRoot ? [''] : [])],
    true,
  );
  const chosen = new Set([...scope.dirs, ...reach.members]);
  return {
    entries: reach.entries,
    members: members.filter((member) => chosen.has(member.dir)),
  };
}

/** What the layout is told: every member directory, and what to link and shim. */
export function workspaceLayout(
  tree: PackageLockTree,
  installed: readonly LockMember[],
): FrozenLockWorkspace | undefined {
  const workspace = tree.workspace;
  if (workspace === undefined || workspace.members.length === 0)
    return undefined;
  const dirs = new Set(installed.map((member) => member.dir));
  return {
    memberDirs: workspace.members.map((member) => member.dir),
    layout: {
      members: installed.map((member) => ({
        dir: member.dir,
        name: member.name,
        bin: member.bin,
      })),
      links: workspace.links
        .filter((link) => dirs.has(link.dir))
        .map(({ path, target }) => ({ path, target })),
    },
  };
}
