import { resolve } from 'node:path';
import { normalizeJailPaths } from './paths.js';
import { matchPackageGrant, mergeGrants } from './policy.js';
import type { RunInSandboxInput } from './types.js';

/**
 * How many handles a sandboxed process may inherit. Every path a run binds is
 * opened first and handed to the backend as an inherited no-follow handle, so a
 * path swapped after it was checked cannot redirect the bind (ADR 0036), and
 * the spawner refuses more than this many (`spawnCapture`). The bound is the
 * spawner's own: bwrap has none, and MXC takes no handles.
 */
export const MAX_INHERITED_HANDLES = 16;

type BindInput = Pick<
  RunInSandboxInput,
  | 'policy'
  | 'packageId'
  | 'grants'
  | 'readwritePaths'
  | 'readonlyPaths'
  | 'cwd'
  | 'directoryAuthorities'
  | 'executableAuthority'
>;

/**
 * The paths a run binds: its own, the jail's home (writable, when given) and
 * what the policy grants its package, each path once.
 */
export function boundPaths(
  input: BindInput,
  jailHome?: string,
): { readwrite: string[]; readonly: string[] } {
  const grants = mergeGrants(
    matchPackageGrant(input.packageId, input.policy.packages),
    input.grants,
  );
  return {
    readwrite: normalizeJailPaths(
      [
        ...input.readwritePaths,
        ...(jailHome === undefined ? [] : [jailHome]),
        ...normalizeJailPaths(grants.write, 'write grant'),
      ],
      'readwrite path',
    ),
    readonly: normalizeJailPaths(
      [
        ...input.readonlyPaths,
        ...normalizeJailPaths(grants.read, 'read grant'),
      ],
      'readonly path',
    ),
  };
}

/**
 * The bound paths, and the working directory, that no handle was passed for:
 * `runInSandbox` opens one handle for each.
 */
export function pathsToOpen(
  input: BindInput,
  bound: { readwrite: readonly string[]; readonly: readonly string[] },
): string[] {
  const opened = new Set(
    (input.directoryAuthorities ?? []).map(({ path }) => resolve(path)),
  );
  const paths: string[] = [];
  for (const path of [
    ...bound.readwrite,
    ...bound.readonly,
    resolve(input.cwd),
  ])
    if (!opened.has(path)) {
      opened.add(path);
      paths.push(path);
    }
  return paths;
}

/**
 * How many handles the process of a run with this input inherits: those passed
 * in, one for each other path it binds and for its working directory, one for
 * the jail's home (made fresh for every run) and the executable's, if any.
 */
export function inheritedHandleCount(input: BindInput): number {
  return (
    (input.directoryAuthorities?.length ?? 0) +
    pathsToOpen(input, boundPaths(input)).length +
    1 +
    (input.executableAuthority === undefined ? 0 : 1)
  );
}
