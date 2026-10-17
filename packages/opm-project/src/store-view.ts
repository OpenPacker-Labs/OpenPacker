import { mkdir, rm, type FileHandle } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { materialiseTree } from '@openpacker/project-io';
import { MAX_INHERITED_HANDLES } from '@openpacker/sandbox';
import { openStableDirectory } from './paths.js';
import { scratchName, sweepAbandoned } from './run-scratch.js';
import { OpmError } from './types.js';

const VIEW_PREFIX = '.view-';

/**
 * Whether a name in a store is a running tool's view rather than a store path:
 * `opm gc` must not remove what a sandbox has bound.
 */
export const isStoreView = (name: string): boolean =>
  name.startsWith(VIEW_PREFIX);

/**
 * Store entries bound into a sandbox through one directory handle per store,
 * not one per entry.
 *
 * Every path the sandbox binds is opened first and handed to bwrap as an
 * inherited no-follow descriptor (`--ro-bind-fd`, `@openpacker/sandbox`'s
 * run.ts), so a path swapped for a symlink after it was checked cannot redirect
 * the bind. The process spawner caps those at MAX_INHERITED_HANDLES (16), and a
 * tool runs with every package of its closure, so `opmx pkg:npm/cowsay hi` (33
 * packages) was refused.
 *
 * The entries of one store directory are laid out instead as a fresh directory
 * of hard links to exactly those entries, opened once and bound where the store
 * is. Inside the sandbox the store holds the same entries at the same paths as
 * when each was bound on its own, and nothing else: no other package in the
 * store, and not the view itself, becomes visible. The bind stays read-only,
 * and a store file's bytes are not copied. The links are made through no-follow
 * handles as a layout's are, so a symlink is refused here as a bind refuses it.
 *
 * The view is made inside the store, the one place sure to be on the same file
 * system and kept by opm. While it is there each entry's files have a second
 * name, so the shared store's `opm gc` counts the entry as in use.
 */
export interface StoreView {
  /** What to bind read-only: the store directories, and lone entries as they are. */
  readonlyPaths: string[];
  /** The handle each store directory is bound from. */
  authorities: { fd: number; path: string }[];
  /** Close the handles and remove the views. */
  dispose(): Promise<void>;
}

/**
 * Which stores' entries are bound through a view, so that all of `paths` take
 * at most `budget` handles: none when each fits bound alone, as a store that
 * cannot be written to needs, and otherwise the fewest, the stores with the
 * most entries first. A view costs a link per file and write access to its
 * store; an entry bound alone costs neither.
 */
export function storesToView(
  paths: readonly string[],
  budget: number,
): Map<string, string[]> {
  const byStore = new Map<string, string[]>();
  for (const path of paths)
    byStore.set(dirname(path), [...(byStore.get(dirname(path)) ?? []), path]);
  const viewed = new Map<string, string[]>();
  let handles = paths.length;
  for (const [store, entries] of [...byStore].sort(
    ([, left], [, right]) => right.length - left.length,
  )) {
    if (handles <= budget || entries.length < 2) break;
    viewed.set(store, entries);
    handles -= entries.length - 1;
  }
  if (handles > budget)
    throw new OpmError(
      'SANDBOX_UNAVAILABLE',
      `This run binds ${paths.length} store entries from ${byStore.size} ` +
        `stores; with a view of each store that is ${handles} handles, and ` +
        `besides the project, the working directory, the jail's home and ` +
        `grants there is room for ${Math.max(budget, 0)} of the ` +
        `${MAX_INHERITED_HANDLES} a sandboxed process may inherit.`,
    );
  return viewed;
}

/**
 * Bind `paths` (store entries) in at most `budget` handles: one each while
 * they fit, through a view of their store where they do not.
 */
export async function storeViews(
  paths: readonly string[],
  budget: number,
): Promise<StoreView> {
  const unique = [...new Set(paths.map((item) => resolve(item)))];
  const viewed = storesToView(unique, budget);
  const readonlyPaths = unique.filter((path) => !viewed.has(dirname(path)));
  const authorities: StoreView['authorities'] = [];
  const handles: FileHandle[] = [];
  const views: string[] = [];
  const dispose = async () => {
    await Promise.all(handles.map((handle) => handle.close().catch(() => {})));
    for (const view of views) await rm(view, { recursive: true, force: true });
  };
  try {
    for (const [store, entries] of viewed) {
      await sweepAbandoned(store, VIEW_PREFIX);
      const view = join(store, scratchName(VIEW_PREFIX));
      await mkdir(view, { mode: 0o755 }).catch((error: Error) => {
        throw new OpmError(
          'SANDBOX_UNAVAILABLE',
          `${unique.length} store entries do not fit in the ${budget} of ` +
            `the ${MAX_INHERITED_HANDLES} handles a sandboxed process may ` +
            `inherit that are left for them, so the ${entries.length} of ` +
            `${store} are bound through a view of it, and it cannot be made ` +
            `there: ${error.message}`,
          { cause: error },
        );
      });
      views.push(view);
      // Each file linked is the very inode opened through the store's
      // no-follow handles; a name swapped meanwhile is refused (ADR 0048).
      for (const entry of entries)
        await materialiseTree(entry, join(view, basename(entry)), view, {
          link: true,
        });
      const handle = await openStableDirectory(view);
      handles.push(handle);
      authorities.push({ fd: handle.fd, path: store });
      readonlyPaths.push(store);
    }
  } catch (error) {
    await dispose();
    throw error;
  }
  return { readonlyPaths, authorities, dispose };
}
