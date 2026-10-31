/**
 * Trusted bases: the only places a stable walk takes a symbolic link.
 *
 * A stable walk opens every component of its path with `O_NOFOLLOW`, so a link
 * anywhere in the path is refused. Below a root opm was given that is the
 * point: a link swapped into a project, a store or a cache must never redirect
 * a read or a write. Above such a root it is wrong. The operating system and
 * the person choose where `TMPDIR`, `HOME`, the XDG directories, the `OPM_*`
 * homes and a project are, and those locations are reached through links of
 * their own: every `TMPDIR` on macOS is under `/var`, a link to `/private/var`;
 * a home directory may be on an automounter; a project may be opened through a
 * linked directory, as npm, pnpm and git all allow.
 *
 * So a base is resolved with `realpath` once, when it is taken, and recorded
 * here. A walk replaces the longest base its path begins with by that real
 * path and opens the rest one component at a time with `O_NOFOLLOW`, as it
 * always did. Nothing below a base is resolved, so a link there is still
 * refused. ADR 0034, amendment of 2026-10-31.
 *
 * Two kinds of base:
 *
 * - **Taken.** `trustBase(path)` resolves `path` and records it: the project
 *   root (`projectPaths` in opm-project), a directory a person named on the
 *   command line. Taking a base again resolves it again.
 * - **The environment's.** `os.tmpdir()`, `os.homedir()` and the absolute
 *   values of `XDG_CACHE_HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`,
 *   `XDG_STATE_HOME`, `OPM_STORE_HOME`, `OPM_TOOL_CACHE` and
 *   `OPM_PLUGIN_HOME`. These are read, and so taken, by each walk that starts
 *   under one; nothing has to record them first.
 */

import { realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

/** The environment variables whose absolute values are bases. */
export const BASE_VARIABLES: readonly string[] = [
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'OPM_STORE_HOME',
  'OPM_TOOL_CACHE',
  'OPM_PLUGIN_HOME',
];

/** How many taken bases are kept; the oldest is forgotten first. */
const KEPT = 512;

/**
 * One record per process, even when the ESM and the CommonJS build of this
 * package are both loaded (ADR 0017): a base one of them took is a base for
 * the other.
 */
const RECORD = Symbol.for('openpacker.project-io.trusted-bases');
type Taken = Map<string, string>;
const holder = globalThis as typeof globalThis & { [RECORD]?: Taken };
const taken: Taken = (holder[RECORD] ??= new Map());

/**
 * The real path of `path`: `realpath` of its deepest ancestor that exists
 * (itself, when it does), with the components that do not exist yet appended
 * as they are written. Anything other than a missing component (a loop, a
 * file where a directory is named, no permission) leaves `path` as it is, and
 * the walk that follows refuses it with its own error.
 */
export function realBase(path: string): string {
  const absolute = resolve(path);
  const missing: string[] = [];
  let candidate = absolute;
  for (;;) {
    try {
      return join(realpathSync.native(candidate), ...missing.reverse());
    } catch (error) {
      // SAFETY: fs calls throw Error values with an optional errno code.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return absolute;
    }
    const parent = dirname(candidate);
    if (parent === candidate) return absolute;
    missing.push(basename(candidate));
    candidate = parent;
  }
}

/**
 * Take `path` as a base: resolve it now, record it, and return its real path.
 * A link in `path` itself, its last component included, is taken as the
 * person or the operating system made it; nothing below it ever is.
 */
export function trustBase(path: string): string {
  const lexical = resolve(path);
  const real = realBase(lexical);
  taken.delete(lexical);
  taken.set(lexical, real);
  for (const oldest of taken.keys()) {
    if (taken.size <= KEPT) break;
    taken.delete(oldest);
  }
  return real;
}

/** The environment's bases, as written: absolute values only. */
export function environmentBases(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const bases: string[] = [];
  for (const read of [tmpdir, homedir])
    try {
      bases.push(read());
    } catch {
      // A process with no home directory has no home base.
    }
  for (const name of BASE_VARIABLES) bases.push(env[name]?.trim() ?? '');
  return bases.filter((base) => base !== '' && isAbsolute(base));
}

function under(path: string, base: string): boolean {
  return (
    path === base || path.startsWith(base.endsWith(sep) ? base : base + sep)
  );
}

/** The longest base `absolute` lies in or is, and its recorded real path if taken. */
function longestBase(
  absolute: string,
  env: NodeJS.ProcessEnv,
): { lexical: string; real?: string } | undefined {
  let found: { lexical: string; real?: string } | undefined;
  const longer = (lexical: string) =>
    under(absolute, lexical) && lexical.length > (found?.lexical.length ?? -1);
  for (const [lexical, real] of taken)
    if (longer(lexical)) found = { lexical, real };
  for (const base of environmentBases(env)) {
    const lexical = resolve(base);
    if (longer(lexical)) found = { lexical };
  }
  return found;
}

/**
 * The longest base `path` lies in or is, and that base's real path, or
 * undefined when it lies under none. An environment base is resolved here,
 * as it is read; a taken base is as it was recorded.
 */
export function baseOf(
  path: string,
  env: NodeJS.ProcessEnv = process.env,
): { lexical: string; real: string } | undefined {
  const found = longestBase(resolve(path), env);
  if (found === undefined) return undefined;
  return {
    lexical: found.lexical,
    real: found.real ?? realBase(found.lexical),
  };
}

/**
 * `path` with the base it lies under replaced by that base's real path: what
 * a stable walk opens, one `O_NOFOLLOW` component at a time. A path under no
 * base is returned as it is, absolute, and every link in it is refused.
 */
export function stableTarget(
  path: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const absolute = resolve(path);
  const base = baseOf(absolute, env);
  if (base === undefined) return absolute;
  const rest = absolute.slice(base.lexical.length).split(sep).filter(Boolean);
  return join(base.real, ...rest);
}

/** Whether `path` is itself a base, taken or the environment's. */
export function isBase(
  path: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const absolute = resolve(path);
  return longestBase(absolute, env)?.lexical === absolute;
}
