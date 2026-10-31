/**
 * Which shared package store a process uses, and whether it may trust it.
 *
 * Kept apart from the store's mechanics (`shared-store.ts`) because the
 * decision is made by every caller that wants to know whether links are in
 * play, and by `opm gc --shared`, which never publishes anything.
 */

import { lstat, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { realBase, trustBase } from '@openpacker/project-io';
import { OpmError } from './types.js';
import {
  defaultSharedStoreHome,
  ensureStableDirectory,
  sharedStoreSetting,
} from './paths.js';
import { openPrivateDirectory } from './stable-ops.js';

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
  return requestedStore(env);
}

function requestedStore(env: NodeJS.ProcessEnv): RequestedStore | undefined {
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

/**
 * Make (with `create`) and judge the shared store root, and take it as a base
 * once it is found private.
 *
 * The root as named must not itself be a link: its owner and mode are what is
 * judged, and a link's own are meaningless (ADR 0048). The links on the way to
 * it are the environment's and are taken, as a base's are: none inside a
 * project (`realBase`). The root is made, every directory that was missing
 * mode 0700, and judged through handles opened one no-follow component at a
 * time from its real path, so nothing is made where a link below a base
 * points, and what is judged is what was opened. Only then is it taken
 * (`trustBase`, as a validated store root), so a root that was refused is
 * never a base (ADR 0034).
 */
export async function ensurePrivateRoot(
  root: string,
  explicit: boolean,
  create = true,
  /** What the root is, in what is said of it. */
  what = 'Shared store root',
): Promise<void> {
  const named = await lstat(root).catch((error: NodeJS.ErrnoException) => {
    if (create && error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (named?.isSymbolicLink() === true) throw linkedRoot(root, what);
  const real = realBase(root);
  const handle = await openPrivateDirectory(real, create).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ELOOP' || error.code === 'ENOTDIR')
        throw linkedRoot(root, what);
      throw error;
    },
  );
  try {
    const info = await handle.stat();
    if (!info.isDirectory()) throw linkedRoot(root, what);
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
  } finally {
    await handle.close();
  }
  if (trustBase(root, 'validated private root') !== real)
    throw new OpmError(
      'INPUT_CHANGED',
      `${what} changed while it was checked: ${root}`,
    );
  await ensureStableDirectory(root);
}

function linkedRoot(root: string, what: string): OpmError {
  return new OpmError(
    'UNSAFE_PATH',
    `${what} is linked or not a directory: ${root}`,
  );
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
