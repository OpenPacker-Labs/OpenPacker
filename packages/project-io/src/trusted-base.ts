/**
 * Trusted bases: the only places a stable walk takes a symbolic link.
 *
 * A stable walk opens every component of its path with `O_NOFOLLOW`, so a link
 * anywhere in the path is refused. Below a root opm was given that is the
 * point: a link swapped into a project, a store or a cache must never redirect
 * a read or a write. Above such a root it is wrong. The operating system and
 * the person choose where `TMPDIR`, `HOME`, the XDG directories and a project
 * are, and those locations are reached through links of their own: every
 * `TMPDIR` on macOS is under `/var`, a link to `/private/var`; a home directory
 * may be on an automounter; a project may be opened through a linked
 * directory, as npm, pnpm and git all allow.
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
 *   ({@link BaseChooser}): the project root a command was given, and the
 *   private roots it found owned by this user and writable by nobody else
 *   (the shared store, the tool cache, the configuration directory). Taking a
 *   base again checks that it still leads where it did.
 * - **The environment's**: `os.tmpdir()`, `os.homedir()` and the absolute
 *   values of `XDG_CACHE_HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`,
 *   `XDG_STATE_HOME` and `OPM_PLUGIN_HOME`, resolved the first time a walk
 *   starts under one and kept.
 *
 * A base is resolved by `base-resolve.ts`, one directory handle at a time:
 * no link in a fenced directory is followed, and none another user put in a
 * sticky directory anyone may write to. A fence is the identity of a
 * directory whose links are its own: the project the command runs in (fenced
 * before any base is resolved, {@link beginCommand}), every root taken, and
 * nothing is ever unfenced while the command runs. A fence added after a base
 * was resolved through a link it holds unmakes that base.
 *
 * A base leads to one place for the whole command: a walk under one first
 * checks that its path still leads to the directory it was resolved to, and
 * refuses with `INPUT_CHANGED` before anything is done when it does not.
 */

import { lstatSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';
import {
  componentsOf,
  currentEuid,
  identityKey,
  identityOf,
  resolveWith,
  resolverOps,
  sameIdentity,
  type Identity,
  type Resolution,
} from './base-resolve.js';
import { ProjectIoError } from './index.js';

/** The environment variables whose absolute values are bases. */
export const BASE_VARIABLES: readonly string[] = [
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
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
   * The shared store root an environment named, taken only once
   * `ensurePrivateRoot` in opm-project found it owned by this user and
   * writable by nobody else.
   */
  | 'validated private root'
  /** The opmx tool cache, judged as the store root is (`openToolCache`). */
  | 'tool cache'
  /** The directory of opm's own configuration (`opm auth`), judged as the store root is. */
  | 'config root';

interface Taken extends Resolution {
  readonly chosenBy: BaseChooser;
}

interface Bases {
  taken: Map<string, Taken>;
  environment: Map<string, Resolution>;
  /** Fence key → a path that named it, for what is said. */
  fences: Map<string, string>;
}

/** How many taken bases are kept; the oldest is forgotten first. Fences are never forgotten. */
const KEPT = 512;

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
    fences: new Map(),
  });
}

/**
 * Forget every base and every fence: the end of a command. A process that
 * runs one command (the CLI) never needs this; a host that runs several in
 * one process calls {@link beginCommand} at the start of each, and a test
 * suite calls this between tests, so that what one took is not a base for the
 * next.
 */
export function forgetBases(): void {
  delete (globalThis as Holder)[RECORD];
}

function under(path: string, base: string): boolean {
  return (
    path === base || path.startsWith(base.endsWith(sep) ? base : base + sep)
  );
}

function resolveBase(path: string): Resolution {
  return resolveWith(resolverOps(), path, {
    fences: bases().fences,
    euid: currentEuid(),
  });
}

/**
 * Fence `identity`: no link in or below that directory is followed by a
 * resolution from now on, and every base already resolved through one is
 * forgotten, to be resolved again (and refused) when it is next used.
 */
function addFence(identity: Identity, path: string): void {
  const record = bases();
  const key = identityKey(identity);
  if (record.fences.has(key)) return;
  record.fences.set(key, path);
  for (const [lexical, resolution] of record.environment)
    if (resolution.linkAncestors.has(key)) record.environment.delete(lexical);
  for (const [lexical, resolution] of record.taken)
    if (resolution.linkAncestors.has(key)) record.taken.delete(lexical);
}

function changed(lexical: string, was: string, now: string): ProjectIoError {
  return new ProjectIoError(
    'INPUT_CHANGED',
    lexical,
    `${lexical} led to ${was} when this command began and leads to ${now} now; it was changed while opm was using it`,
  );
}

function sameResolution(a: Resolution, b: Resolution): boolean {
  return a.identity !== undefined || b.identity !== undefined
    ? sameIdentity(a.identity, b.identity)
    : a.real === b.real;
}

function record(lexical: string, taken: Taken): void {
  const { taken: map } = bases();
  if (taken.identity !== undefined) addFence(taken.identity, lexical);
  map.set(lexical, taken);
  for (const oldest of map.keys()) {
    if (map.size <= KEPT) break;
    map.delete(oldest);
  }
}

/**
 * The real path of `path`, resolved the way a base is (no link in a fence
 * followed, nor one another user put in a sticky directory), without taking
 * it. A path that does not resolve comes back with the rest as written.
 */
export function realBase(path: string): string {
  return resolveBase(path).real;
}

/**
 * Take `path` as a base, on `chosenBy`'s word: resolve it, record it for the
 * command, fence it, and return its real path. A link in `path` itself, its
 * last component included, is taken as the person or the operating system
 * made it; one in a fence is not, and nothing below `path` ever is.
 *
 * Taking it again resolves it again: a path that leads somewhere else now than
 * when it was first taken is refused with `INPUT_CHANGED`, so one command does
 * not write half its files in one directory and half in another.
 */
export function trustBase(path: string, chosenBy: BaseChooser): string {
  const lexical = resolve(path);
  const now = resolveBase(lexical);
  const known = bases().taken.get(lexical);
  if (known !== undefined) {
    if (!sameResolution(known, now))
      throw changed(lexical, known.real, now.real);
    return known.real;
  }
  record(lexical, { ...now, chosenBy });
  return now.real;
}

/** A directory opened by its caller, to be taken as the base `lexical` names (`takeOpened`). */
export interface OpenedBase {
  /** Where the system says the open directory is. */
  readonly real: string;
  readonly identity: Identity;
  /** The fence keys of the directories a link followed on the way to it lay in. */
  readonly linkAncestors: ReadonlySet<string>;
}

/**
 * Take the directory a caller opened and judged as the base `lexical`, with
 * no resolution of its own: what was judged is what is taken. `INPUT_CHANGED`
 * when `lexical` was taken before and that was another directory.
 */
export function takeOpened(
  lexical: string,
  opened: OpenedBase,
  chosenBy: BaseChooser,
): string {
  const path = resolve(lexical);
  const known = bases().taken.get(path);
  if (known !== undefined) {
    if (!sameIdentity(known.identity, opened.identity))
      throw changed(path, known.real, opened.real);
    return known.real;
  }
  record(path, {
    real: opened.real,
    identity: opened.identity,
    linkAncestors: opened.linkAncestors,
    refused: undefined,
    reached: {
      depth: componentsOf(opened.real).length,
      identity: opened.identity,
    },
    chosenBy,
  });
  return opened.real;
}

/** `path` resolved as a base is, for the callers that walk from what it reached (`stable-walk.ts`). */
export function resolveForWalk(path: string): Resolution {
  return resolveBase(path);
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

/** An environment base, resolved the first time it is used and kept until a fence unmakes it. */
function environmentBase(lexical: string): Resolution {
  const record = bases().environment;
  let known = record.get(lexical);
  if (known === undefined) {
    known = resolveBase(lexical);
    record.set(lexical, known);
  }
  return known;
}

interface Found {
  lexical: string;
  resolution?: Resolution;
}

/** The longest base `absolute` lies in or is, with its resolution where `resolveIt`. */
function longestBase(
  absolute: string,
  env: NodeJS.ProcessEnv,
  resolveIt: boolean,
): Found | undefined {
  let found: Found | undefined;
  const longer = (lexical: string) =>
    under(absolute, lexical) && lexical.length > (found?.lexical.length ?? -1);
  for (const [lexical, taken] of bases().taken)
    if (longer(lexical)) found = { lexical, resolution: taken };
  for (const base of environmentBases(env)) {
    const lexical = resolve(base);
    if (!longer(lexical)) continue;
    found = resolveIt
      ? { lexical, resolution: environmentBase(lexical) }
      : { lexical };
  }
  return found;
}

/** What a stable walk of a path opens, and what it must find on the way. */
export interface WalkPlan {
  /** The path with its base replaced by the base's real path. */
  readonly target: string;
  /** How many components of `target`, from its root, are the base's own. */
  readonly baseDepth: number;
  /** The directory the walk must find after `baseDepth` components; undefined when there is nothing to check. */
  readonly baseIdentity: Identity | undefined;
}

/**
 * What a stable walk of `path` opens. The base `path` lies under must still
 * lead where it did when it was resolved: one that leads to another directory
 * now (a `TMPDIR` link retargeted, a project root moved) is `INPUT_CHANGED`
 * here, before the walk does anything.
 */
export function walkPlan(
  path: string,
  env: NodeJS.ProcessEnv = process.env,
): WalkPlan {
  const absolute = resolve(path);
  const found = longestBase(absolute, env, true);
  const resolution = found?.resolution;
  if (found === undefined || resolution === undefined)
    return { target: absolute, baseDepth: 0, baseIdentity: undefined };
  if (resolution.identity !== undefined) {
    const now = identityOf(found.lexical);
    if (!sameIdentity(now, resolution.identity))
      throw changed(
        found.lexical,
        resolution.real,
        now === undefined ? 'nothing' : 'another directory',
      );
  }
  const rest = absolute.slice(found.lexical.length).split(sep).filter(Boolean);
  return {
    target: join(resolution.real, ...rest),
    baseDepth:
      resolution.identity === undefined
        ? 0
        : componentsOf(resolution.real).length,
    baseIdentity: resolution.identity,
  };
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
  if (found?.resolution === undefined) return undefined;
  return { lexical: found.lexical, real: found.resolution.real };
}

/**
 * `path` with the base it lies under replaced by that base's real path: what
 * a stable walk opens, one `O_NOFOLLOW` component at a time. A path under no
 * base is returned as it is, absolute, and every link in it is refused.
 * `INPUT_CHANGED` when the base leads somewhere else now ({@link walkPlan}).
 */
export function stableTarget(
  path: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return walkPlan(path, env).target;
}

/**
 * Refuse with `INPUT_CHANGED` when the base `path` lies under leads somewhere
 * else now than when it was resolved: what a write checks before it publishes.
 */
export function assertBaseUnchanged(path: string): void {
  walkPlan(path);
}

/** Whether `path` is itself a base, taken or the environment's. */
export function isBase(
  path: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const absolute = resolve(path);
  return longestBase(absolute, env, false)?.lexical === absolute;
}

/** Whether `a` and `b` lead to the same directory now, by its identity, whatever names them. */
export function sameDirectory(a: string, b: string): boolean {
  return sameIdentity(identityOf(a), identityOf(b));
}

/** What says a directory is a project: opm's own files, npm's, a checkout. */
const PROJECT_MARKERS = ['opm.toml', 'opm.lock.json', 'package.json', '.git'];

function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Fence the project the command runs in: the nearest directory, from the
 * working directory's real path up, that holds a project marker, else the
 * working directory itself. Its links are the project's (`.cache -> /outside`,
 * committed), so no base is resolved through one, whatever the environment
 * names there. The search stops below the home directory, and neither the
 * home directory, a directory above it nor a file system's root is ever
 * fenced: the person's own links (`~/.cache -> /data/cache`) are theirs.
 * Returns the directory fenced, if any.
 */
export function fenceWorkingProject(cwd: string): string | undefined {
  const start = resolveBase(cwd);
  if (start.identity === undefined) return undefined;
  let home: string | undefined;
  try {
    home = resolveBase(homedir()).real;
  } catch {
    // A process with no home directory has no home to keep out.
  }
  const outside = (dir: string) =>
    dir === parse(dir).root || (home !== undefined && under(home, dir));
  let chosen: string | undefined;
  for (let dir = start.real; !outside(dir); dir = dirname(dir))
    if (PROJECT_MARKERS.some((marker) => present(join(dir, marker)))) {
      chosen = dir;
      break;
    }
  if (chosen === undefined && !outside(start.real)) chosen = start.real;
  if (chosen === undefined) return undefined;
  const identity = identityOf(chosen);
  if (identity === undefined) return undefined;
  addFence(identity, chosen);
  return chosen;
}

/**
 * Begin a command run in `cwd`: forget what the last one took, then fence the
 * project it runs in before any base is resolved ({@link fenceWorkingProject}).
 * Every process entry calls it first, and so does a host that runs several
 * commands in one process, at each.
 */
export function beginCommand(cwd: string): void {
  forgetBases();
  fenceWorkingProject(cwd);
}
