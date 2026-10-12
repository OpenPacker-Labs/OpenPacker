import { WorkspaceError } from './errors.js';
import type { WorkspaceLimits } from './limits.js';
import type { WorkspaceManifest } from './manifest.js';
import { compareText, workspaceNameProblem } from './names.js';

export type WorkspaceTool = 'npm' | 'pnpm';

/** One package of the workspace: a directory with a `package.json`. */
export interface WorkspaceMember {
  /**
   * The directory relative to the workspace root, with `/` separators and no
   * leading or trailing separator; `''` is the root itself. It is the member's
   * identity: two members never share one, and a name can be absent.
   */
  readonly dir: string;
  readonly root: boolean;
  /**
   * The name other members depend on it by. The manifest's, or, under npm only,
   * the directory's name when the manifest has none, as npm names a workspace;
   * `undefined` for a nameless pnpm member or root, which no dependency can
   * point at.
   */
  readonly name: string | undefined;
  readonly nameFromDirectory: boolean;
  readonly manifest: WorkspaceManifest;
}

/** A directory and the manifest read from it, before any naming rule is applied. */
export interface MemberSource {
  readonly dir: string;
  readonly manifest: WorkspaceManifest;
}

/** `packages/@scope/x` is named `@scope/x`, as npm does; anything else by its last segment. */
export function nameFromDirectory(dir: string): string | undefined {
  const segments = dir.split('/').filter((segment) => segment !== '');
  const last = segments.at(-1);
  if (last === undefined) return undefined;
  const parent = segments.at(-2);
  return parent?.startsWith('@') === true ? `${parent}/${last}` : last;
}

/** How a member is shown in a message: its name and where it lives. */
export function describeMember(member: {
  readonly dir: string;
  readonly name: string | undefined;
}): string {
  if (member.name === undefined)
    return member.dir === '' ? '(root)' : member.dir;
  return `${member.name} (${member.dir === '' ? 'root' : member.dir})`;
}

/**
 * Turn the manifests found into members: apply the naming rule of `tool`,
 * refuse a name that cannot be a package name, refuse two members with one
 * name, and put them in one order everywhere: the root, then by directory in
 * code-unit order.
 */
export function assembleMembers(
  sources: readonly MemberSource[],
  tool: WorkspaceTool,
  limits: WorkspaceLimits,
): readonly WorkspaceMember[] {
  if (sources.length > limits.maxMembers)
    throw new WorkspaceError(
      'WORKSPACE_LIMIT_EXCEEDED',
      `The workspace has ${sources.length} members, more than the limit of ${limits.maxMembers}`,
    );
  const members: WorkspaceMember[] = [];
  const seenDirectories = new Set<string>();
  for (const source of [...sources].sort((a, b) => compareText(a.dir, b.dir))) {
    if (seenDirectories.has(source.dir))
      throw new WorkspaceError(
        'WORKSPACE_NAME_DUPLICATE',
        `The directory ${source.dir === '' ? '(root)' : source.dir} was found twice`,
        [source.dir],
      );
    seenDirectories.add(source.dir);
    const root = source.dir === '';
    const written = source.manifest.name;
    const derived =
      written === undefined && tool === 'npm' && !root
        ? nameFromDirectory(source.dir)
        : undefined;
    const name = written ?? derived;
    if (name !== undefined) {
      const problem = workspaceNameProblem(name);
      if (problem !== undefined)
        throw new WorkspaceError(
          'WORKSPACE_NAME_INVALID',
          `${source.dir === '' ? '(root)' : source.dir}: ${problem}`,
          [source.dir],
        );
    }
    members.push({
      dir: source.dir,
      root,
      name,
      nameFromDirectory: derived !== undefined,
      manifest: source.manifest,
    });
  }
  refuseDuplicateNames(members);
  return members;
}

function joinPaths(dirs: readonly string[]): string {
  const shown = dirs.map((dir) => (dir === '' ? '(root)' : dir));
  return shown.length < 3
    ? shown.join(' and ')
    : `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}`;
}

function refuseDuplicateNames(members: readonly WorkspaceMember[]): void {
  const byName = new Map<string, string[]>();
  for (const member of members) {
    if (member.name === undefined) continue;
    const dirs = byName.get(member.name) ?? [];
    dirs.push(member.dir);
    byName.set(member.name, dirs);
  }
  for (const [name, dirs] of byName)
    if (dirs.length > 1)
      throw new WorkspaceError(
        'WORKSPACE_NAME_DUPLICATE',
        `${dirs.length === 2 ? 'Two' : dirs.length} workspace members are named ${JSON.stringify(name)}: ${joinPaths(dirs)}`,
        dirs,
      );
}
