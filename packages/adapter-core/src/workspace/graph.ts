import { WorkspaceError } from './errors.js';
import type { DependencyField } from './manifest.js';
import { compareText, workspaceNameProblem } from './names.js';
import { describeMember, type WorkspaceMember } from './members.js';
import type { RangeEngine } from './ranges.js';
import {
  indexMembers,
  isWorkspaceSpecifier,
  parseWorkspaceSpec,
  resolveRelativeDirectory,
  resolveWorkspaceSpec,
  type MemberIndex,
} from './spec.js';

/**
 * Whether a plain range links to a member, which is a setting of the tool and
 * never a guess:
 *
 * - `workspace-protocol`: only a `workspace:` specifier, or a `link:` / `file:`
 *   path, reaches a member. This is pnpm's default since v9
 *   (`link-workspace-packages` off); a plain `^1.0.0` is fetched from the
 *   registry even when a member of that name exists.
 * - `satisfied-range`: a plain range also reaches the member of that name when
 *   the member's version satisfies it. This is how npm always behaves, and
 *   pnpm's with `link-workspace-packages` on.
 */
export type LinkPolicy = 'workspace-protocol' | 'satisfied-range';

export type EdgeVia = 'workspace-protocol' | 'range' | 'path';

/** One dependency that points at another member. */
export interface WorkspaceEdge {
  /** The dependent's directory. */
  readonly from: string;
  /** The dependency's directory. */
  readonly to: string;
  /** The key in the dependent's manifest: the name of the link in its `node_modules`. */
  readonly dependency: string;
  readonly field: DependencyField;
  /** The specifier exactly as the manifest wrote it. */
  readonly specifier: string;
  readonly via: EdgeVia;
  /** An optional dependency, or a peer `peerDependenciesMeta` marks optional. */
  readonly optional: boolean;
}

export interface WorkspaceGraph {
  /** The root first, then by directory. */
  readonly members: readonly WorkspaceMember[];
  readonly linkPolicy: LinkPolicy;
  readonly index: MemberIndex;
  /** Edges between two different members, ordered by dependent (root first) and then dependency name. */
  readonly edges: readonly WorkspaceEdge[];
  /** A member that lists itself. Not linked and not ordered; kept so a pack can rewrite it. */
  readonly selfEdges: readonly WorkspaceEdge[];
  readonly outgoing: ReadonlyMap<string, readonly WorkspaceEdge[]>;
  readonly incoming: ReadonlyMap<string, readonly WorkspaceEdge[]>;
}

export interface GraphOptions {
  readonly linkPolicy: LinkPolicy;
  readonly ranges: RangeEngine;
}

const ARCHIVE = /\.(?:tgz|tar|tar\.gz|zip)$/u;

function pathSpecifierTarget(specifier: string): string | undefined {
  const prefix = specifier.startsWith('link:')
    ? 'link:'
    : specifier.startsWith('file:')
      ? 'file:'
      : undefined;
  if (prefix === undefined) return undefined;
  const path = specifier.slice(prefix.length);
  if (path === '' || path.startsWith('/') || path.startsWith('//'))
    return undefined;
  if (prefix === 'file:' && ARCHIVE.test(path)) return undefined;
  return path;
}

function plainRangeReaches(
  member: WorkspaceMember,
  specifier: string,
  ranges: RangeEngine,
): boolean {
  const written = specifier.trim();
  if (written === '' || written === '*') return true;
  const version = member.manifest.version;
  return version !== undefined && ranges.satisfies(version, written) === true;
}

interface Located {
  readonly target: WorkspaceMember;
  readonly via: EdgeVia;
}

function locate(
  from: WorkspaceMember,
  field: DependencyField,
  dependency: string,
  specifier: string,
  index: MemberIndex,
  options: GraphOptions,
): Located | undefined {
  const where = `${describeMember(from)} ${field}[${JSON.stringify(dependency)}]`;
  if (isWorkspaceSpecifier(specifier)) {
    const spec = parseWorkspaceSpec(specifier, where, options.ranges);
    return {
      target: resolveWorkspaceSpec(
        spec,
        dependency,
        from,
        index,
        options.ranges,
      ),
      via: spec.kind === 'path' ? 'path' : 'workspace-protocol',
    };
  }
  const path = pathSpecifierTarget(specifier);
  if (path !== undefined) {
    const dir = resolveRelativeDirectory(from.dir, path);
    const target = dir === undefined ? undefined : index.byDir.get(dir);
    return target === undefined ? undefined : { target, via: 'path' };
  }
  if (options.linkPolicy !== 'satisfied-range') return undefined;
  const target = index.byName.get(dependency);
  return target !== undefined &&
    plainRangeReaches(target, specifier, options.ranges)
    ? { target, via: 'range' }
    : undefined;
}

/**
 * A dependency key listed in several of a manifest's lists counts once, under
 * the list that wins: `dependencies`, then `optionalDependencies`, then
 * `devDependencies`, then `peerDependencies`. That is how pnpm merges them
 * before it orders or links anything, and a directory can hold one link.
 */
const PRECEDENCE: readonly DependencyField[] = [
  'dependencies',
  'optionalDependencies',
  'devDependencies',
  'peerDependencies',
];

function mergedDependencies(member: WorkspaceMember): readonly {
  dependency: string;
  field: DependencyField;
  specifier: string;
}[] {
  const merged = new Map<
    string,
    { field: DependencyField; specifier: string }
  >();
  for (const field of [...PRECEDENCE].reverse())
    for (const [dependency, specifier] of member.manifest[field])
      merged.set(dependency, { field, specifier });
  return [...merged]
    .map(([dependency, entry]) => ({ dependency, ...entry }))
    .sort((left, right) => compareText(left.dependency, right.dependency));
}

/**
 * Work out which dependencies of which members point at other members. A
 * `workspace:` specifier that names nothing, or that this model does not
 * support, ends the build with an error that names the specifier and the
 * member, as an install would; a plain range that no member satisfies is an
 * ordinary registry dependency and is not an edge.
 */
export function buildWorkspaceGraph(
  members: readonly WorkspaceMember[],
  options: GraphOptions,
): WorkspaceGraph {
  const index = indexMembers(members);
  const edges: WorkspaceEdge[] = [];
  const selfEdges: WorkspaceEdge[] = [];
  const outgoing = new Map<string, WorkspaceEdge[]>();
  const incoming = new Map<string, WorkspaceEdge[]>();
  for (const member of members) {
    outgoing.set(member.dir, []);
    incoming.set(member.dir, []);
  }
  for (const member of members) {
    for (const { dependency, field, specifier } of mergedDependencies(member)) {
      const found = locate(
        member,
        field,
        dependency,
        specifier,
        index,
        options,
      );
      if (found === undefined) continue;
      const problem = workspaceNameProblem(dependency);
      if (problem !== undefined)
        throw new WorkspaceError(
          'WORKSPACE_NAME_INVALID',
          `${describeMember(member)} ${field}[${JSON.stringify(dependency)}] points at ${describeMember(found.target)}, but the dependency key cannot name a link: ${problem}`,
          [member.dir],
        );
      const edge: WorkspaceEdge = {
        from: member.dir,
        to: found.target.dir,
        dependency,
        field,
        specifier,
        via: found.via,
        optional:
          field === 'optionalDependencies' ||
          (field === 'peerDependencies' &&
            member.manifest.optionalPeers.has(dependency)),
      };
      if (edge.from === edge.to) {
        selfEdges.push(edge);
        continue;
      }
      edges.push(edge);
      outgoing.get(edge.from)?.push(edge);
      incoming.get(edge.to)?.push(edge);
    }
  }
  return {
    members,
    linkPolicy: options.linkPolicy,
    index,
    edges,
    selfEdges,
    outgoing,
    incoming,
  };
}
