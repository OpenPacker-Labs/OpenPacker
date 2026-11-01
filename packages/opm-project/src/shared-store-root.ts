/**
 * Which shared package store a process uses, and whether it may trust it.
 *
 * Kept apart from the store's mechanics (`shared-store.ts`) because the
 * decision is made by every caller that wants to know whether links are in
 * play, and by `opm gc --shared`, which never publishes anything.
 */

import { lstat, mkdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { OpmError } from './types.js';
import {
  defaultSharedStoreHome,
  ensureStableDirectory,
  sharedStoreSetting,
} from './paths.js';

let defaultEnabled = false;

/**
 * Turn the user-level shared store on for this process.
 *
 * Called by the process entries (`opm`, `opmx`) the way they register
 * adapters; the library never decides it for a caller, which is what keeps a
 * test or an embedding host from writing to the real user cache. Once on,
 * `OPM_STORE_HOME` still wins (a path, or `off`), and the default store is
 * only used where it can actually save disk — see `usableSharedRoot`.
 */
export function enableDefaultSharedStore(enabled = true): void {
  defaultEnabled = enabled;
}

/**
 * The shared store root this process was asked for, or undefined.
 *
 * `OPM_STORE_HOME=/abs/path` names one; `off` refuses one; otherwise the
 * default applies when a process entry enabled it. Relative values fail
 * closed. Whether the root is usable is `usableSharedRoot`'s question.
 */
export function sharedStoreRoot(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return requestedSharedStore(env)?.root;
}

export interface RequestedStore {
  root: string;
  /** Named by the operator, so a problem with it is an error, not a fallback. */
  explicit: boolean;
}

export function requestedSharedStore(
  env: NodeJS.ProcessEnv,
): RequestedStore | undefined {
  const setting = sharedStoreSetting(env);
  if (setting.kind === 'path') return { root: setting.root, explicit: true };
  // Windows cannot hard-link through directory handles here, so the default
  // store would only add a copy.
  if (
    setting.kind === 'default' &&
    defaultEnabled &&
    process.platform !== 'win32'
  )
    return { root: defaultSharedStoreHome(env), explicit: false };
  return undefined;
}

/**
 * The shared store a project at `projectPath` should use, created if need be.
 *
 * An explicit `OPM_STORE_HOME` that cannot be used is an error. The default
 * store is an optimisation and never the reason an install fails: if it
 * cannot be created, is not private to this user, or lives on another device
 * than the project (so every link would become a copy and the store would
 * only add a second copy of everything), the project simply keeps its own.
 */
export async function usableSharedRoot(
  projectPath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const requested = requestedSharedStore(env);
  if (requested === undefined) return undefined;
  try {
    await ensurePrivateRoot(requested.root, requested.explicit);
    if (!requested.explicit && !(await sameDevice(requested.root, projectPath)))
      return undefined;
    return requested.root;
  } catch (error) {
    if (requested.explicit) throw error;
    return undefined;
  }
}

export async function ensurePrivateRoot(
  root: string,
  explicit: boolean,
  create = true,
  /** What the root is, in what is said of it. */
  what = 'Shared store root',
): Promise<void> {
  if (create) await mkdir(root, { recursive: true, mode: 0o700 });
  const info = await lstat(root);
  if (info.isSymbolicLink() || !info.isDirectory())
    throw new OpmError(
      'UNSAFE_PATH',
      `${what} is linked or not a directory: ${root}`,
    );
  if (process.platform !== 'win32') {
    const uid = process.geteuid?.();
    if (uid !== undefined && info.uid !== uid)
      throw new OpmError(
        'UNSAFE_PATH',
        `${what} ${root} is not owned by the current user`,
      );
    // The default is ours to create, so it must be exactly private. A root an
    // operator named may be looser, but never writable by anyone else: whoever
    // can write here decides what every project on the machine runs.
    const forbidden = explicit ? 0o022 : 0o077;
    if ((info.mode & forbidden) !== 0)
      throw new OpmError(
        'UNSAFE_PATH',
        `${what} ${root} is accessible to other users (mode ${(info.mode & 0o777).toString(8)}); it must be private to its owner`,
      );
  }
  await ensureStableDirectory(root);
}

async function sameDevice(root: string, projectPath: string): Promise<boolean> {
  let candidate = resolve(projectPath);
  for (;;) {
    try {
      return (await stat(candidate)).dev === (await stat(root)).dev;
    } catch (error) {
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const parent = dirname(candidate);
    if (parent === candidate) return false;
    candidate = parent;
  }
}
