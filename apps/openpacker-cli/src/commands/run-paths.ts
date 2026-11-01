/**
 * Where `opm run` and `opm exec` look for executables, and the environment
 * they start them in (ADR 0047).
 *
 * Everything here is a pure function of its inputs plus one file probe that a
 * caller may replace, so the Windows rules are tested on every host.
 */
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import path from 'node:path';

/** `path`, `path.posix` or `path.win32`: the one place a flavour is chosen. */
export type PathFlavor = typeof path.posix;

/**
 * `node_modules/.bin` of `root` and of each ancestor directory, nearest first.
 *
 * npm adds every one of them whether or not it exists, because a parent
 * directory may be installed into later. Lookups skip what is absent.
 */
export function binDirectories(
  root: string,
  flavor: PathFlavor = path,
): string[] {
  const directories: string[] = [];
  let current = flavor.resolve(root);
  for (;;) {
    directories.push(flavor.join(current, 'node_modules', '.bin'));
    const parent = flavor.dirname(current);
    if (parent === current) return directories;
    current = parent;
  }
}

/**
 * The nearest directory, from `start` upward, that holds an `opm.toml`.
 *
 * `findOpmRoot` in `@openpacker/opm-project` answers the same question and a
 * test holds the two together; it is repeated here because loading that
 * library costs more than the rest of `opm run` put together.
 */
export async function findProjectRoot(
  start: string,
  flavor: PathFlavor = path,
): Promise<string | undefined> {
  let current = flavor.resolve(start);
  for (;;) {
    try {
      await access(flavor.join(current, 'opm.toml'));
      return current;
    } catch {
      // not here
    }
    const parent = flavor.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** The environment variable holding the search path: `Path` on Windows. */
export function pathKey(
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
): string {
  if (platform !== 'win32') return 'PATH';
  return Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'Path';
}

export interface ScriptEnvironmentInput {
  /** The environment to inherit; never modified. */
  base: Readonly<Record<string, string | undefined>>;
  binDirs: readonly string[];
  /** `npm_lifecycle_event`: the script being run, or `exec`. */
  event: string;
  packageName?: string | undefined;
  packageVersion?: string | undefined;
  /** The directory `opm` was invoked in, unless an outer run already said. */
  initCwd: string;
  platform: NodeJS.Platform;
}

/**
 * The child's environment: the inherited one, `PATH` led by the `.bin`
 * directories, and four names set — `npm_lifecycle_event`, `npm_package_name`,
 * `npm_package_version` and `INIT_CWD`. Nothing else is added, removed or
 * rewritten, and nothing here is ever printed.
 */
export function scriptEnvironment(
  input: ScriptEnvironmentInput,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.base))
    if (value !== undefined) environment[key] = value;
  const key = pathKey(environment, input.platform);
  const delimiter = input.platform === 'win32' ? ';' : ':';
  const inherited = environment[key];
  environment[key] = [
    ...input.binDirs,
    ...(inherited === undefined || inherited === '' ? [] : [inherited]),
  ].join(delimiter);
  environment.npm_lifecycle_event = input.event;
  if (input.packageName !== undefined)
    environment.npm_package_name = input.packageName;
  if (input.packageVersion !== undefined)
    environment.npm_package_version = input.packageVersion;
  // The outermost invocation names where the person was; a nested `opm run`
  // inside a script keeps that answer.
  environment.INIT_CWD = environment.INIT_CWD || input.initCwd;
  return environment;
}

/** `runnable`: a file that can be executed. `present`: a file that cannot. */
export type BinProbe = 'runnable' | 'present' | 'absent';

export interface BinLookup {
  platform: NodeJS.Platform;
  /** `PATHEXT` on Windows; `.COM;.EXE;.BAT;.CMD` when unset. */
  pathext?: string | undefined;
  probe?: ((file: string) => Promise<BinProbe>) | undefined;
  flavor?: PathFlavor | undefined;
}

export interface BinResolution {
  /** The first runnable match, nearest directory first. */
  found?: string;
  /** Files by that name that exist but cannot be executed. */
  present: string[];
}

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

/** Probe a file on this machine: a regular file, executable where that means anything. */
export async function probeFile(
  file: string,
  platform: NodeJS.Platform = process.platform,
): Promise<BinProbe> {
  try {
    // stat follows links: a `.bin` entry may be one, however opm wrote its own.
    if (!(await stat(file)).isFile()) return 'absent';
  } catch {
    return 'absent';
  }
  if (platform === 'win32') return 'runnable';
  try {
    await access(file, constants.X_OK);
    return 'runnable';
  } catch {
    return 'present';
  }
}

/** The names a bin can have on disk: Windows adds an extension, POSIX does not. */
export function binCandidates(
  name: string,
  platform: NodeJS.Platform,
  pathext: string | undefined,
): string[] {
  if (platform !== 'win32') return [name];
  const extensions = (pathext || DEFAULT_PATHEXT)
    .split(';')
    .map((extension) => extension.trim().toLowerCase())
    .filter((extension) => extension.startsWith('.'));
  const lower = name.toLowerCase();
  // Windows never runs the extensionless POSIX shim opm writes beside `.cmd`.
  return [
    ...(extensions.some((extension) => lower.endsWith(extension))
      ? [name]
      : []),
    ...extensions.map((extension) => `${name}${extension}`),
  ];
}

/**
 * Find `name` in `directories`, in order. Never searches the inherited `PATH`
 * and never fetches anything: `opm exec` runs what the project has.
 */
export async function resolveBin(
  name: string,
  directories: readonly string[],
  lookup: BinLookup,
): Promise<BinResolution> {
  const flavor = lookup.flavor ?? path;
  const probe =
    lookup.probe ?? ((file: string) => probeFile(file, lookup.platform));
  const present: string[] = [];
  for (const directory of directories)
    for (const candidate of binCandidates(
      name,
      lookup.platform,
      lookup.pathext,
    )) {
      const file = flavor.join(directory, candidate);
      const state = await probe(file);
      if (state === 'runnable') return { found: file, present };
      if (state === 'present') present.push(file);
    }
  return { present };
}

/** Why a name cannot be a bin, or `undefined`. A bin is a name, never a path. */
export function binNameProblem(
  name: string,
  platform: NodeJS.Platform,
): string | undefined {
  if (name === '') return 'the name is empty';
  if (name === '.' || name === '..') return 'the name is a directory';
  if (/[\\/\0]/u.test(name))
    return 'the name contains a path separator; exec takes a bin name, not a path';
  if (platform === 'win32' && name.includes(':'))
    return 'the name contains a colon';
  return undefined;
}
