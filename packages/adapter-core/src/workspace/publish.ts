import { WorkspaceError } from './errors.js';
import type { WorkspaceGraph } from './graph.js';
import type { DependencyField } from './manifest.js';
import { describeMember, type WorkspaceMember } from './members.js';
import type { RangeEngine } from './ranges.js';
import {
  isWorkspaceSpecifier,
  parseWorkspaceSpec,
  resolveWorkspaceSpec,
  type WorkspaceSpec,
} from './spec.js';

/**
 * The specifier a dependency is published as. `workspace:` means "this member
 * of the repository", which means nothing to a registry, so pnpm rewrites it
 * when it packs, from the member it names:
 *
 * | written               | published                     |
 * | --------------------- | ----------------------------- |
 * | `workspace:*`         | `1.2.3`                       |
 * | `workspace:^`         | `^1.2.3`                      |
 * | `workspace:~`         | `~1.2.3`                      |
 * | `workspace:^1.2.3`    | `^1.2.3`                      |
 * | `workspace:1.2.3`     | `1.2.3`                       |
 * | `workspace:../b`      | `1.2.3`                       |
 * | any of those, aliased | `npm:real-name@` + the above  |
 *
 * A key that is not the member's own name is an alias and is published as
 * `npm:<name>@...`, which is also what an alias written in the specifier gives.
 * A member with no name or no version cannot be published against, as pnpm
 * fails (`CANNOT_RESOLVE_WORKSPACE_PROTOCOL`).
 *
 * Differences from pnpm, stated: `workspace:.` and `workspace:..` are paths here
 * and are rewritten like `../b` (pnpm leaves them as `.`), and a peer
 * dependency is rewritten only in the simple forms above (pnpm rewrites a peer
 * range textually, and mangles an aliased one).
 */
export function publishedSpecifier(
  spec: WorkspaceSpec,
  dependency: string,
  target: WorkspaceMember,
  field: DependencyField,
  from: WorkspaceMember,
): string {
  const where = `${describeMember(from)} ${field}[${JSON.stringify(dependency)}]`;
  const version = target.manifest.version;
  const name = target.name;
  if (name === undefined || version === undefined)
    throw new WorkspaceError(
      'WORKSPACE_SPEC_UNRESOLVED',
      `${where} is ${JSON.stringify(spec.written)}, which cannot be published because ${describeMember(target)} has no ${name === undefined ? 'name' : 'version'}`,
      [from.dir, target.dir],
    );
  if (
    field === 'peerDependencies' &&
    (spec.kind === 'path' || spec.alias !== undefined)
  )
    throw new WorkspaceError(
      'WORKSPACE_SPEC_UNSUPPORTED',
      `${where}: the peer specifier ${JSON.stringify(spec.written)} cannot be rewritten for publication; use a plain workspace:*, ^, ~ or range`,
      [from.dir],
    );
  const range =
    spec.kind === 'path'
      ? version
      : spec.range.mode === 'any'
        ? `${spec.range.token === '*' ? '' : spec.range.token}${version}`
        : spec.range.text;
  return dependency !== name ||
    (spec.kind === 'range' && spec.alias !== undefined)
    ? `npm:${name}@${range}`
    : range;
}

/**
 * A member's four dependency lists as they will read in the published
 * manifest: every `workspace:` specifier rewritten from the member it
 * resolves to, every other specifier untouched. Each list is read on its own,
 * as pnpm packs them, so a key listed in two lists is rewritten in both.
 */
export function publishedDependencies(
  graph: WorkspaceGraph,
  dir: string,
  ranges: RangeEngine,
): Readonly<Record<DependencyField, ReadonlyMap<string, string>>> {
  const member = graph.index.byDir.get(dir);
  if (member === undefined)
    throw new WorkspaceError(
      'WORKSPACE_SPEC_UNRESOLVED',
      `No workspace member lives at ${dir === '' ? '(root)' : dir}`,
      [dir],
    );
  const rewrite = (field: DependencyField): ReadonlyMap<string, string> => {
    const rewritten = new Map<string, string>();
    for (const [dependency, written] of member.manifest[field]) {
      if (!isWorkspaceSpecifier(written)) {
        rewritten.set(dependency, written);
        continue;
      }
      const where = `${describeMember(member)} ${field}[${JSON.stringify(dependency)}]`;
      const spec = parseWorkspaceSpec(written, where, ranges);
      const target = resolveWorkspaceSpec(
        spec,
        dependency,
        member,
        graph.index,
        ranges,
      );
      rewritten.set(
        dependency,
        publishedSpecifier(spec, dependency, target, field, member),
      );
    }
    return rewritten;
  };
  return {
    dependencies: rewrite('dependencies'),
    devDependencies: rewrite('devDependencies'),
    optionalDependencies: rewrite('optionalDependencies'),
    peerDependencies: rewrite('peerDependencies'),
  };
}
