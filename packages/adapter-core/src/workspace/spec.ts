import { WorkspaceError } from './errors.js';
import { describeMember, type WorkspaceMember } from './members.js';
import { workspaceNameProblem } from './names.js';
import type { RangeEngine } from './ranges.js';

/**
 * `workspace:` specifiers, as pnpm reads them (Yarn and Bun write the same
 * forms):
 *
 * | written               | meaning                                         |
 * | --------------------- | ----------------------------------------------- |
 * | `workspace:*`         | the member, whatever its version                |
 * | `workspace:^`, `~`    | the member; published as `^v` and `~v`          |
 * | `workspace:1.2.3`     | the member, if it is at that version            |
 * | `workspace:^1.2.3`    | the member, if its version is in that range     |
 * | `workspace:name@...`  | the member called `name`, under another key     |
 * | `workspace:../path`   | the member in that directory                    |
 */
export type SpecRange =
  | { readonly mode: 'any'; readonly token: '*' | '^' | '~' }
  | { readonly mode: 'semver'; readonly text: string };

export type WorkspaceSpec =
  | {
      readonly kind: 'range';
      readonly written: string;
      /** The member's own name when the dependency key is an alias for it. */
      readonly alias: string | undefined;
      readonly range: SpecRange;
    }
  | {
      readonly kind: 'path';
      readonly written: string;
      /** Relative to the directory of the member that wrote it. */
      readonly path: string;
    };

export const WORKSPACE_PREFIX = 'workspace:';

export function isWorkspaceSpecifier(written: string): boolean {
  return written.startsWith(WORKSPACE_PREFIX);
}

function unsupported(
  written: string,
  where: string,
  reason: string,
): WorkspaceError {
  return new WorkspaceError(
    'WORKSPACE_SPEC_UNSUPPORTED',
    `${where}: the specifier ${JSON.stringify(written)} is not supported: ${reason}`,
    [where],
  );
}

// pnpm's own pattern: an alias is a name that does not start with ".", "_" or "/".
const FORM = /^workspace:(?:(?<alias>[^._/][^@]*)@)?(?<version>.*)$/u;

/**
 * Read a `workspace:` specifier. `where` names the member and dependency it
 * came from (`packages/a dependencies["b"]`) and is how a refusal names them.
 */
export function parseWorkspaceSpec(
  written: string,
  where: string,
  ranges: RangeEngine,
): WorkspaceSpec {
  const parts = FORM.exec(written)?.groups;
  if (parts === undefined)
    throw unsupported(written, where, 'not a workspace: form');
  const alias = parts['alias'];
  const version = parts['version'] ?? '';
  if (alias !== undefined) {
    const problem = workspaceNameProblem(alias);
    if (problem !== undefined)
      throw unsupported(
        written,
        where,
        `the alias is not a package name (${problem})`,
      );
  }
  if (version === '')
    throw unsupported(
      written,
      where,
      'it names no version; write workspace:* to accept any',
    );
  if (version === '*' || version === '^' || version === '~')
    return {
      kind: 'range',
      written,
      alias,
      range: { mode: 'any', token: version },
    };
  if (version.startsWith('/'))
    throw unsupported(written, where, 'an absolute path leaves the workspace');
  if (
    version === '.' ||
    version === '..' ||
    version.startsWith('./') ||
    version.startsWith('../')
  ) {
    if (alias !== undefined)
      throw unsupported(written, where, 'a path cannot carry an alias');
    return { kind: 'path', written, path: version };
  }
  if (ranges.satisfies('0.0.0', version) === undefined)
    throw unsupported(
      written,
      where,
      'it is not a version range, a path, or *, ^ and ~ (a dist-tag cannot name a workspace member)',
    );
  return {
    kind: 'range',
    written,
    alias,
    range: { mode: 'semver', text: version },
  };
}

/** Members indexed the two ways a specifier finds one. */
export interface MemberIndex {
  readonly byName: ReadonlyMap<string, WorkspaceMember>;
  readonly byDir: ReadonlyMap<string, WorkspaceMember>;
}

export function indexMembers(members: readonly WorkspaceMember[]): MemberIndex {
  const byName = new Map<string, WorkspaceMember>();
  const byDir = new Map<string, WorkspaceMember>();
  for (const member of members) {
    byDir.set(member.dir, member);
    if (member.name !== undefined) byName.set(member.name, member);
  }
  return { byName, byDir };
}

/** The version a member counts as: a package with none is at 0.0.0, as pnpm installs it. */
export function effectiveVersion(member: WorkspaceMember): string {
  return member.manifest.version ?? '0.0.0';
}

/** `dir` joined to `path` with `.` and `..` resolved, or `undefined` when it leaves the root. */
export function resolveRelativeDirectory(
  dir: string,
  path: string,
): string | undefined {
  const parts = dir === '' ? [] : dir.split('/');
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (parts.pop() === undefined) return undefined;
    } else parts.push(part);
  }
  return parts.join('/');
}

/**
 * The member a `workspace:` specifier names. It fails, by name, when no member
 * has that name or lives there, or when the member's version is not one the
 * specifier accepts: an install would fail on it, so the model does too.
 */
export function resolveWorkspaceSpec(
  spec: WorkspaceSpec,
  dependency: string,
  from: WorkspaceMember,
  index: MemberIndex,
  ranges: RangeEngine,
): WorkspaceMember {
  const where = `${describeMember(from)} depends on ${JSON.stringify(dependency)} as ${JSON.stringify(spec.written)}`;
  const unresolved = (problem: string) =>
    new WorkspaceError(
      'WORKSPACE_SPEC_UNRESOLVED',
      `${where}, but ${problem}`,
      [from.dir],
    );
  if (spec.kind === 'path') {
    const target = resolveRelativeDirectory(from.dir, spec.path);
    if (target === undefined)
      throw unresolved('that path leaves the workspace root');
    const member = index.byDir.get(target);
    if (member === undefined)
      throw unresolved(
        `no workspace member lives at ${target === '' ? '(root)' : target}`,
      );
    return member;
  }
  const name = spec.alias ?? dependency;
  const member = index.byName.get(name);
  if (member === undefined)
    throw unresolved(`no workspace member is named ${JSON.stringify(name)}`);
  if (spec.range.mode === 'semver') {
    const version = effectiveVersion(member);
    if (ranges.satisfies(version, spec.range.text) !== true)
      throw unresolved(
        `${describeMember(member)} is at version ${version}, which does not satisfy ${spec.range.text}`,
      );
  }
  return member;
}
