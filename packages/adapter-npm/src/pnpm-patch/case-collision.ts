/**
 * The files a patch creates, held to the archive's CASE_COLLISION rule against
 * the package's files (ADR 0056 §13).
 *
 * An archive is refused when two of its entries have one `collisionKey`, the
 * whole path lowercased: one case-insensitive file system would make them one
 * file. A patch names the files it changes and the directories above them, not
 * the rest of the package, so a created file's twins are looked for in the
 * package: segment by segment, from the root, among the names of a directory
 * that fold to the segment's (`Lib` and `lib` are both followed; the key of a
 * path is its segments' keys joined, since lowercasing never makes a `/`). A file the
 * patch deletes or moves away is not a twin: the check is on the entry as the
 * patch leaves it.
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { collisionKey } from '@openpacker/adapter-core';
import type { PatchBudget } from './apply.js';
import { LSTAT_UNITS, type PatchNode } from './tree.js';

type Nodes = ReadonlyMap<string, PatchNode | undefined>;

/** Two files of the entry the patch leaves that an archive would refuse. */
export interface CaseCollision {
  readonly path: string;
  readonly other: string;
}

/**
 * What following one existing directory, or one name of a listing, costs the
 * budget besides the length of what is compared: the string built and the map
 * looked in. A package may hold a directory in every case of one name at every
 * level, and each is followed.
 */
export const FOLLOW_UNITS = 64;

/**
 * The first created file that has a twin, or undefined. Charges `budget` for
 * each directory read (a system call and its names) and each directory
 * followed. The directories a path's parent folds to are found once for the
 * parent's key, and their names indexed once, however many files are created
 * in it and however the patch spells it.
 */
export async function caseCollision(
  root: string,
  before: Nodes,
  after: Nodes,
  budget: PatchBudget,
): Promise<CaseCollision | undefined> {
  // A directory's names, by key: `Lib` and `lib` under `lib`.
  const listings = new Map<string, ReadonlyMap<string, readonly string[]>>();
  const namesIn = async (
    directory: string,
  ): Promise<ReadonlyMap<string, readonly string[]>> => {
    const known = listings.get(directory);
    if (known !== undefined) return known;
    budget.charge(LSTAT_UNITS);
    const where = directory === '' ? root : join(root, ...directory.split('/'));
    const names = await readdir(where).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return [];
      throw error;
    });
    const byKey = new Map<string, string[]>();
    for (const name of names) {
      budget.charge(name.length + 1);
      const key = collisionKey(name);
      const same = byKey.get(key);
      if (same === undefined) byKey.set(key, [name]);
      else same.push(name);
    }
    listings.set(directory, byKey);
    return byKey;
  };
  const below = (directory: string, name: string) =>
    directory === '' ? name : `${directory}/${name}`;

  /**
   * The existing directories whose path folds to `spelled`, as a path of the
   * patch spells it. They depend on the path's key only (each segment is
   * matched by its key), so `Big` and `BIG` are found once, by `big`.
   */
  const directories = new Map<string, readonly string[]>([['', ['']]]);
  const directoriesOf = async (spelled: string): Promise<readonly string[]> => {
    const folded = collisionKey(spelled);
    const known = directories.get(folded);
    if (known !== undefined) return known;
    const at = spelled.lastIndexOf('/');
    const segment = spelled.slice(at + 1);
    const fold = collisionKey(segment);
    const found: string[] = [];
    for (const parent of await directoriesOf(
      spelled.slice(0, Math.max(at, 0)),
    )) {
      budget.charge(FOLLOW_UNITS + segment.length);
      for (const name of (await namesIn(parent)).get(fold) ?? [])
        found.push(below(parent, name));
    }
    directories.set(folded, found);
    return found;
  };

  /**
   * Every name below those directories, by key, as the path it is: merged once
   * for every spelling of the parent, so what it holds is bounded by the
   * package's own entries, not by the spellings a patch uses.
   */
  const indexes = new Map<string, ReadonlyMap<string, readonly string[]>>();
  const indexOf = async (
    parent: string,
  ): Promise<ReadonlyMap<string, readonly string[]>> => {
    const folded = collisionKey(parent);
    const known = indexes.get(folded);
    if (known !== undefined) return known;
    const merged = new Map<string, string[]>();
    for (const directory of await directoriesOf(parent))
      for (const [key, names] of await namesIn(directory))
        for (const name of names) {
          budget.charge(FOLLOW_UNITS + name.length);
          const same = merged.get(key);
          if (same === undefined) merged.set(key, [below(directory, name)]);
          else same.push(below(directory, name));
        }
    indexes.set(folded, merged);
    return merged;
  };

  const created = [...after]
    .filter(
      ([path, node]) =>
        node?.kind === 'file' && before.get(path)?.kind !== 'file',
    )
    .map(([path]) => path)
    .sort();
  const keys = new Map<string, string>();
  for (const path of created) {
    const key = collisionKey(path);
    const twin = keys.get(key);
    if (twin !== undefined) return { path, other: twin };
    keys.set(key, path);
    const at = path.lastIndexOf('/');
    const name = path.slice(at + 1);
    const index = await indexOf(at === -1 ? '' : path.slice(0, at));
    for (const found of index.get(collisionKey(name)) ?? [])
      if (
        found !== path &&
        // Named by the patch, it is as the patch leaves it; else it is there.
        (!after.has(found) || after.get(found) !== undefined)
      )
        return { path, other: found };
  }
  return undefined;
}
