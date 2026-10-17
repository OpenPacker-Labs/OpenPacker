import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import { toolCacheRoot } from '../src/ephemeral.js';
import { defaultSharedStoreHome, sharedStoreHome } from '../src/paths.js';

/**
 * Keeps a test run away from the caller's package store and caches.
 *
 * opm reads a user-level store or cache location from OPM_STORE_HOME (the
 * shared store), OPM_TOOL_CACHE (the opmx tool cache) and XDG_CACHE_HOME (where
 * both default to, else `~/.cache`). A run inherits the caller's environment,
 * so a caller that exported OPM_STORE_HOME had every install in the suite use
 * its real store, and a test that tampers with a store file wrote through a
 * hard link into it.
 *
 * The plugin store is read the same way, from OPM_PLUGIN_HOME, else
 * XDG_DATA_HOME, else `~/.local/share`.
 *
 * Each test file gets a fresh directory as XDG_CACHE_HOME and XDG_DATA_HOME,
 * and OPM_STORE_HOME, OPM_TOOL_CACHE and OPM_PLUGIN_HOME are unset, as in CI:
 * the library uses no shared store unless a test names one, the tool cache and
 * plugin store are the fresh directory's, and a process entry that turns the
 * default store on gets the fresh directory's too. Pointing OPM_STORE_HOME
 * itself at a fresh store instead turns the shared store on for every test,
 * which the suite is not written for (61 of its tests then fail).
 */
export function isolateStores(): { root: string; remove(): void } {
  const root = mkdtempSync(join(tmpdir(), 'opm-test-stores-'));
  delete process.env.OPM_STORE_HOME;
  delete process.env.OPM_TOOL_CACHE;
  delete process.env.OPM_PLUGIN_HOME;
  process.env.XDG_CACHE_HOME = join(root, 'cache');
  process.env.XDG_DATA_HOME = join(root, 'data');
  return {
    root,
    remove: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** `path` with its longest existing prefix resolved, so a link is followed. */
function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(realOrSelf(parent), basename(path));
  }
}

/**
 * Throws unless `path` is inside this machine's temporary directory, where a
 * run's own stores and every store a test makes for itself live.
 */
export function assertTestStorePath(path: string, what: string): void {
  const temporary = realOrSelf(tmpdir());
  const rel = relative(temporary, realOrSelf(resolve(path)));
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel))
    throw new Error(
      `${what} resolves to ${path}, outside the temporary directory ${temporary}: a test must never read or write the caller's store`,
    );
}

/** `resolve()`, or undefined when it refuses (a relative override fails closed). */
function resolvedOrRefused(
  resolve: () => string | undefined,
): string | undefined {
  try {
    return resolve();
  } catch {
    return undefined;
  }
}

/**
 * Throws when the library, asked now with this process's environment, would
 * put the shared store, the default store, the tool cache or any of `more`
 * anywhere but the temporary directory. A relative override is refused by the
 * library itself, so it is left to the test that set it.
 */
export function assertResolvedStores(
  more: Readonly<Record<string, () => string>> = {},
): void {
  const resolvers: Record<string, () => string | undefined> = {
    OPM_STORE_HOME: () => sharedStoreHome(process.env),
    'The default shared store': () => defaultSharedStoreHome(process.env),
    'The tool cache': toolCacheRoot,
    ...more,
  };
  for (const [what, resolve] of Object.entries(resolvers)) {
    const path = resolvedOrRefused(resolve);
    if (path !== undefined) assertTestStorePath(path, what);
  }
}
