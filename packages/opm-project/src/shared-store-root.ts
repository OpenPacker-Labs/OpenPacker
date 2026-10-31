/**
 * Which shared package store a process uses, and whether it may trust it.
 *
 * Kept apart from the store's mechanics (`shared-store.ts`) because the
 * decision is made by every caller that wants to know whether links are in
 * play, and by `opm gc --shared`, which never publishes anything.
 */

import { stat, type FileHandle } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { openRootDirectory, type BaseChooser } from '@openpacker/project-io';
import { OpmError } from './types.js';
import { defaultSharedStoreHome, sharedStoreSetting } from './paths.js';

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
 * The root is made first, as `mkdir -p` would (missing directories mode
 * 0700), then opened relative to its parent's handle with `O_NOFOLLOW`: the
 * root as named must not itself be a link, whenever one appeared there (its
 * owner and mode are what is judged, and a link's own are meaningless, ADR
 * 0048). The links on the way to it are taken as a base's are
 * (`base-resolve.ts`: none in a fence, none another user put in a sticky
 * directory). Its owner and mode are judged on that handle, and that handle is
 * what is taken (`openRootDirectory`), with nothing resolved again, so a root
 * that was refused is never a base and what was judged is what is used (ADR
 * 0034).
 */
export async function ensurePrivateRoot(
  root: string,
  explicit: boolean,
  create = true,
  /** What the root is, in what is said of it. */
  what = 'Shared store root',
): Promise<void> {
  const handle = await openJudgedRoot(root, {
    create,
    lastMayBeLink: false,
    // The default is ours to create, so it must be exactly private. A root an
    // operator named may be looser, but never writable by anyone else: whoever
    // can write here decides what every project on the machine runs.
    forbidden: explicit ? 0o022 : 0o077,
    chooser: 'validated private root',
    what,
  });
  await handle.close();
}

/**
 * Open the root `root` names (making it, mode 0700, with `create`), judge it
 * owned by this user and writable by nobody else (no bit of `forbidden`), and
 * take what was opened as a base on `chooser`'s word. The caller closes the
 * handle. With `lastMayBeLink` the last component may be a link, judged as
 * every link on the way is; without, a link there is refused.
 */
export async function openJudgedRoot(
  root: string,
  options: {
    create: boolean;
    lastMayBeLink: boolean;
    forbidden: number;
    chooser: BaseChooser;
    what: string;
  },
): Promise<FileHandle> {
  const { what } = options;
  const opening = await openRootDirectory(root, options).catch(
    (error: NodeJS.ErrnoException & { refusedBy?: string }) => {
      if (error.code === 'ELOOP' || error.code === 'ENOTDIR')
        throw linkedRoot(
          root,
          what,
          // Which checkout or fence held the link, as the walk said it.
          error.refusedBy === undefined ? undefined : error.message,
        );
      throw error;
    },
  );
  const { handle } = opening;
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
      if ((info.mode & options.forbidden) !== 0)
        throw new OpmError(
          'UNSAFE_PATH',
          `${what} ${root} is accessible to other users (mode ${(info.mode & 0o777).toString(8)}); it must be private to its owner`,
        );
    }
    opening.take(options.chooser);
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

function linkedRoot(root: string, what: string, why?: string): OpmError {
  return new OpmError(
    'UNSAFE_PATH',
    `${what} is linked or not a directory: ${root}${why === undefined ? '' : ` (${why})`}`,
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

/**
 * Make (with `create`) and judge opmx's tool cache, as the store root is
 * judged, and take it as a base on its own word ('tool cache'). A cache an
 * environment names through a link is taken where the link leads, as `mkdir
 * -p` always took it; the link is judged as every link on the way to a base
 * is. Returns once it is taken; a cache that is not this user's alone is
 * refused.
 */
export async function openToolCache(
  cacheRoot: string,
  create = true,
): Promise<void> {
  const handle = await openJudgedRoot(cacheRoot, {
    create,
    lastMayBeLink: true,
    forbidden: 0o022,
    chooser: 'tool cache',
    what: 'Tool cache',
  });
  await handle.close();
}
