import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import { toolCacheRoot } from '../../packages/opm-project/src/ephemeral.js';
import {
  defaultSharedStoreHome,
  sharedStoreHome,
} from '../../packages/opm-project/src/paths.js';
import { pluginStoreRoot } from '../../packages/plugin-store/src/store.js';

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
 * put the shared store, the default store, the tool cache or the plugin store
 * anywhere but the temporary directory. A relative override is refused by the
 * library itself, so it is left to the test that set it.
 */
export function assertResolvedStores(): void {
  const resolvers: Record<string, () => string | undefined> = {
    OPM_STORE_HOME: () => sharedStoreHome(process.env),
    'The default shared store': () => defaultSharedStoreHome(process.env),
    'The tool cache': toolCacheRoot,
    'The plugin store': () => pluginStoreRoot(process.env),
  };
  for (const [what, resolve] of Object.entries(resolvers)) {
    const path = resolvedOrRefused(resolve);
    if (path !== undefined) assertTestStorePath(path, what);
  }
}
