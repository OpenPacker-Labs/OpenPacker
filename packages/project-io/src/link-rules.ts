/**
 * What a workspace-member link may be, as code.
 *
 * ADR 0043 keeps symlinks out of `node_modules`: a path inside it is never an
 * alias for a path outside it. ADR 0050 makes one exception, a link from a
 * workspace member's name to the member's own directory, and these rules are
 * what keep the exception that small. Every link the package creates passes
 * through them, on every platform, before any call reaches the operating
 * system. They are pure so they can be tested without a filesystem.
 *
 * A link has three parts, and each is checked on its own:
 *
 * - the **directory** it sits in, relative to the project root: `node_modules`,
 *   a scope directory under it, or the same inside a package's own
 *   `node_modules`. Nothing else, so `.bin`, a package's `lib` directory and
 *   the project root itself can never hold a link;
 * - the **name**, one package directory name. A scoped package is a scope
 *   directory and a name, never a name containing a slash;
 * - the **target**, the text of the link, relative to the link's directory.
 */

import { posix } from 'node:path';

/** Most characters a link target may have. */
export const MAXIMUM_TARGET_LENGTH = 1024;

/** A path segment no member may live under, so a link never names a package or opm's own state. */
const FORBIDDEN_TARGET_SEGMENTS = new Set(['node_modules', '.opm']);

const PACKAGE_BODY = /^[A-Za-z0-9._~+-]+$/u;

/**
 * Why `name` is not one package directory name, or undefined.
 *
 * The same rule the layout planner applies to a registry name, stated again
 * here because this package may not depend on the planner and must not trust a
 * caller to have run it.
 */
export function linkNameProblem(name: string): string | undefined {
  if (name === '') return 'a link name is empty';
  if (name.startsWith('@'))
    return `${JSON.stringify(name)} is a scope: a link is named after a package, inside its scope directory`;
  if (
    name.startsWith('.') ||
    name === 'node_modules' ||
    !PACKAGE_BODY.test(name)
  )
    return `${JSON.stringify(name)} is not a safe package directory name`;
  return undefined;
}

function scopeProblem(segment: string): string | undefined {
  const body = segment.slice(1);
  if (
    body === '' ||
    body.startsWith('.') ||
    body === 'node_modules' ||
    !PACKAGE_BODY.test(body)
  )
    return `${JSON.stringify(segment)} is not a safe scope directory name`;
  return undefined;
}

/**
 * Why `directory` (project-root relative, `/`-separated) cannot hold a link,
 * or undefined.
 *
 * The grammar is a `node_modules`, then optionally one scope directory; and,
 * for a package installed there, that package's own `node_modules` with the
 * same again, to any depth.
 */
export function linkDirectoryProblem(directory: string): string | undefined {
  const bad = `${JSON.stringify(directory)} is not a node_modules directory (or a scope directory in one)`;
  if (directory === '' || directory.startsWith('/') || directory.includes('\\'))
    return bad;
  const segments = directory.split('/');
  let at = 0;
  for (;;) {
    if (segments[at] !== 'node_modules') return bad;
    at += 1;
    if (at === segments.length) return undefined;
    const next = segments[at]!;
    if (next.startsWith('@')) {
      const problem = scopeProblem(next);
      if (problem !== undefined) return problem;
      at += 1;
      if (at === segments.length) return undefined;
    }
    const owner = segments[at]!;
    if (owner.startsWith('@') || linkNameProblem(owner) !== undefined)
      return bad;
    at += 1;
    // A package directory is a place to look inside only for its own
    // `node_modules`.
    if (segments[at] !== 'node_modules') return bad;
  }
}

/**
 * Why `target` is not an acceptable link text for a link in `directory`, or
 * undefined.
 *
 * Relative, in normal form (so comparing two targets is comparing two strings),
 * and resolving to a place strictly inside the project root that is neither
 * `node_modules` nor opm's own state: the member's directory, not a registry
 * package and not the project itself.
 */
export function linkTargetProblem(
  directory: string,
  target: string,
): string | undefined {
  const shown = JSON.stringify(target);
  if (target === '') return 'a link target is empty';
  if (target.length > MAXIMUM_TARGET_LENGTH)
    return `the link target is longer than ${MAXIMUM_TARGET_LENGTH} characters`;
  if (['\0', '\r', '\n'].some((forbidden) => target.includes(forbidden)))
    return `the link target ${shown} contains a NUL or a line break`;
  if (target.includes('\\'))
    return `the link target ${shown} contains a backslash; targets are written with /`;
  if (target.startsWith('/') || /^[A-Za-z]:/u.test(target))
    return `the link target ${shown} is absolute; a link points inside the project by a relative path`;
  if (posix.normalize(target) !== target || target.endsWith('/'))
    return `the link target ${shown} is not in normal form (expected ${JSON.stringify(posix.normalize(target).replace(/\/$/u, ''))})`;
  const resolved = posix.normalize(posix.join(directory, target));
  if (resolved === '..' || resolved.startsWith('../'))
    return `the link target ${shown} leaves the project root from ${directory}`;
  if (resolved === '.')
    return `the link target ${shown} is the project root itself`;
  const forbidden = resolved
    .split('/')
    .find((segment) => FORBIDDEN_TARGET_SEGMENTS.has(segment));
  if (forbidden !== undefined)
    return `the link target ${shown} resolves to ${resolved}, which is inside ${forbidden}; only a workspace member's own directory may be linked`;
  return undefined;
}

/** A link's place, split into the directory that holds it and its name. */
export interface LinkPlace {
  directory: string;
  name: string;
}

/**
 * Split a project-root relative link path (`node_modules/@scope/name`) into its
 * directory and name, or say why it cannot be a link's place.
 */
export function splitLinkPath(path: string): LinkPlace | { problem: string } {
  const cut = path.lastIndexOf('/');
  if (cut <= 0) return { problem: `${JSON.stringify(path)} has no directory` };
  const directory = path.slice(0, cut);
  const name = path.slice(cut + 1);
  const problem = linkDirectoryProblem(directory) ?? linkNameProblem(name);
  return problem === undefined ? { directory, name } : { problem };
}

/**
 * Every problem with one link request, joined, or undefined when it is
 * acceptable. `path` is project-root relative.
 */
export function memberLinkProblem(
  path: string,
  target: string,
): string | undefined {
  const place = splitLinkPath(path);
  if ('problem' in place) return place.problem;
  return linkTargetProblem(place.directory, target);
}
