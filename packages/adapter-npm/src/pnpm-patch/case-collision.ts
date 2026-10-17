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

/** The first created file that has a twin, or undefined. Charges `budget` for each directory read. */
export async function caseCollision(
  root: string,
  before: Nodes,
  after: Nodes,
  budget: PatchBudget,
): Promise<CaseCollision | undefined> {
  const listings = new Map<string, readonly string[]>();
  const namesIn = async (directory: string): Promise<readonly string[]> => {
    const known = listings.get(directory);
    if (known !== undefined) return known;
    budget.charge(LSTAT_UNITS);
    const where = directory === '' ? root : join(root, ...directory.split('/'));
    const names = await readdir(where).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return [];
      throw error;
    });
    budget.charge(names.reduce((total, name) => total + name.length + 1, 0));
    listings.set(directory, names);
    return names;
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
    let directories = [''];
    for (const segment of path.split('/')) {
      const fold = collisionKey(segment);
      const next: string[] = [];
      for (const directory of directories)
        for (const name of await namesIn(directory))
          if (collisionKey(name) === fold)
            next.push(directory === '' ? name : `${directory}/${name}`);
      directories = next;
      if (directories.length === 0) break;
    }
    for (const found of directories)
      if (
        found !== path &&
        // Named by the patch, it is as the patch leaves it; else it is there.
        (!after.has(found) || after.get(found) !== undefined)
      )
        return { path, other: found };
  }
  return undefined;
}
