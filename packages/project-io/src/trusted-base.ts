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
 * So a base is resolved once and kept for the command; a walk replaces the
 * longest base its path begins with by that real path and opens the rest one
 * component at a time with `O_NOFOLLOW`, as it always did. Nothing below a
 * base is resolved, so a link there is still refused. ADR 0034, amendment of
 * 2026-10-31.
 *
 * Two kinds of base:
 *
 * - **Taken**, by the code that was handed the path, which says who chose it
 *   ({@link BaseChooser}): the project root a command was given, a shared store
 *   root once it was found private. Taking a base again checks that it still
 *   leads where it did: one command never works in two places under one name.
 * - **The environment's**: `os.tmpdir()`, `os.homedir()` and the absolute
 *   values of `XDG_CACHE_HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`,
 *   `XDG_STATE_HOME`, `OPM_STORE_HOME`, `OPM_TOOL_CACHE` and `OPM_PLUGIN_HOME`,
 *   resolved the first time a walk starts under one and kept.
 *
 * What a project holds is the project's, not the person's: no base is resolved
 * through a link inside a taken base. An environment base that lies in a
 * project (`XDG_CACHE_HOME=$PWD/.cache`, with `.cache` a link the project
 * commits) is resolved no further than the project's real path; one resolved
 * through such a link before the project was taken is not a base at all. Either
 * way the walk meets the project's link below the project root and refuses it.
 */

import { lstatSync, readlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';
import { ProjectIoError } from './index.js';

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

/**
 * Who chose a taken base. A base widens what a walk follows, so whoever takes
 * one says on whose word: a function handed a path it cannot vouch for has no
 * chooser to name.
 */
export type BaseChooser =
  /** The project root a command was given (`projectPaths` in opm-project). */
  | 'project root'
  /**
   * A private root an environment named (the shared store), taken only once
   * `ensurePrivateRoot` in opm-project found it owned by this user and
   * writable by nobody else.
   */
  | 'validated private root';

/** A base's real path, and every link that was followed to get there. */
interface Resolution {
  real: string;
  via: readonly string[];
}

interface Bases {
  taken: Map<string, Resolution & { chosenBy: BaseChooser }>;
  environment: Map<string, Resolution>;
}

/** How many taken bases are kept; the oldest is forgotten first. */
const KEPT = 512;

/** As many links as one resolution follows before it gives up, as Linux does. */
const MAXIMUM_LINKS = 40;

/**
 * One record per process, even when the ESM and the CommonJS build of this
 * package are both loaded (ADR 0017): a base one of them took is a base for
 * the other.
 */
const RECORD = Symbol.for('openpacker.project-io.trusted-bases');
type Holder = typeof globalThis & { [RECORD]?: Bases };

function bases(): Bases {
  return ((globalThis as Holder)[RECORD] ??= {
    taken: new Map(),
    environment: new Map(),
  });
}

/**
 * Forget every base: the end of a command. A process that runs one command
 * (the CLI) never needs this; a host that runs several in one process, and a
 * test suite, calls it between them, so that what one took is not a base for
 * the next.
 */
export function forgetBases(): void {
  delete (globalThis as Holder)[RECORD];
}

function under(path: string, base: string): boolean {
  return (
    path === base || path.startsWith(base.endsWith(sep) ? base : base + sep)
  );
}

function takenReals(except?: string): string[] {
  const reals: string[] = [];
  for (const [lexical, taken] of bases().taken)
    if (lexical !== except) reals.push(taken.real);
  return reals;
}

/**
 * `path` resolved link by link as `realpath(3)` would, except that a link
 * inside a fence (strictly below one of `fences`, the real paths of taken
 * bases) is never followed: from there on the path is kept as written, for the
 * no-follow walk to refuse. A component that does not exist, and anything
 * after it, is kept as written; so is the rest of a path whose resolution
 * fails another way (a file where a directory is named, too many links).
 */
function resolveFenced(path: string, fences: readonly string[]): Resolution {
  const absolute = resolve(path);
  let real = parse(absolute).root;
  const pending = absolute.slice(real.length).split(sep).filter(Boolean);
  const via: string[] = [];
  const kept = (next: string): Resolution => ({
    real: join(next, ...pending),
    via,
  });
  while (pending.length > 0) {
    const name = pending.shift()!;
    if (name === '.') continue;
    if (name === '..') {
      real = dirname(real);
      continue;
    }
    const next = join(real, name);
    if (fences.some((fence) => under(real, fence))) return kept(next);
    let isLink: boolean;
    try {
      isLink = lstatSync(next).isSymbolicLink();
    } catch {
      return kept(next);
    }
    if (!isLink) {
      real = next;
      continue;
    }
    if (via.length >= MAXIMUM_LINKS) return kept(next);
    via.push(next);
    const target = readlinkSync(next).replace(/^\\\\\?\\/u, '');
    if (isAbsolute(target)) real = parse(resolve(target)).root;
    const parts = isAbsolute(target)
      ? resolve(target).slice(real.length).split(sep)
      : target.split(/[\\/]/u);
    pending.unshift(...parts.filter(Boolean));
  }
  return { real, via };
}

/**
 * The real path of `path`, resolved the way a base is (no link inside a taken
 * base followed), without taking it.
 */
export function realBase(path: string): string {
  return resolveFenced(path, takenReals()).real;
}

/**
 * Take `path` as a base, on `chosenBy`'s word: resolve it, record it for the
 * command, and return its real path. A link in `path` itself, its last
 * component included, is taken as the person or the operating system made it;
 * one inside another taken base is not, and nothing below `path` ever is.
 *
 * Taking it again resolves it again: a path that leads somewhere else now than
 * when it was first taken is refused with `INPUT_CHANGED`, so one command does
 * not write half its files in one directory and half in another.
 */
export function trustBase(path: string, chosenBy: BaseChooser): string {
  const lexical = resolve(path);
  const now = resolveFenced(lexical, takenReals(lexical));
  const record = bases().taken;
  const known = record.get(lexical);
  if (known !== undefined) {
    if (known.real !== now.real)
      throw new ProjectIoError(
        'INPUT_CHANGED',
        lexical,
        `${lexical} led to ${known.real} when this command began and leads to ${now.real} now; it was changed while opm was using it`,
      );
    return known.real;
  }
  record.set(lexical, { ...now, chosenBy });
  for (const oldest of record.keys()) {
    if (record.size <= KEPT) break;
    record.delete(oldest);
  }
  return now.real;
}

/** The environment's bases, as written: absolute values only. */
export function environmentBases(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const found: string[] = [];
  for (const read of [tmpdir, homedir])
    try {
      found.push(read());
    } catch {
      // A process with no home directory has no home base.
    }
  for (const name of BASE_VARIABLES) found.push(env[name]?.trim() ?? '');
  return found.filter((base) => base !== '' && isAbsolute(base));
}

/**
 * An environment base, resolved the first time it is used and kept; undefined
 * where its resolution went through a link inside a taken base, which makes
 * it the project's and not the environment's.
 */
function environmentBase(lexical: string): Resolution | undefined {
  const record = bases().environment;
  let known = record.get(lexical);
  if (known === undefined) {
    known = resolveFenced(lexical, takenReals());
    record.set(lexical, known);
  }
  const fences = takenReals();
  if (
    known.via.some((link) =>
      fences.some((fence) => under(link, fence) && link !== fence),
    )
  )
    return undefined;
  return known;
}

/** The longest base `absolute` lies in or is, with its real path. */
function longestBase(
  absolute: string,
  env: NodeJS.ProcessEnv,
  resolveIt: boolean,
): { lexical: string; real?: string } | undefined {
  let found: { lexical: string; real?: string } | undefined;
  const longer = (lexical: string) =>
    under(absolute, lexical) && lexical.length > (found?.lexical.length ?? -1);
  for (const [lexical, taken] of bases().taken)
    if (longer(lexical)) found = { lexical, real: taken.real };
  for (const base of environmentBases(env)) {
    const lexical = resolve(base);
    if (!longer(lexical)) continue;
    if (!resolveIt) {
      found = { lexical };
      continue;
    }
    const resolution = environmentBase(lexical);
    if (resolution !== undefined) found = { lexical, real: resolution.real };
  }
  return found;
}

/**
 * The longest base `path` lies in or is, and that base's real path, or
 * undefined when it lies under none.
 */
export function baseOf(
  path: string,
  env: NodeJS.ProcessEnv = process.env,
): { lexical: string; real: string } | undefined {
  const found = longestBase(resolve(path), env, true);
  if (found?.real === undefined) return undefined;
  return { lexical: found.lexical, real: found.real };
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
  return longestBase(absolute, env, false)?.lexical === absolute;
}
