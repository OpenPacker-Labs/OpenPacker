import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The one directory a package's extracted tree wraps its files in, if any.
 *
 * npm tarballs wrap their contents in one directory, `package/` by convention,
 * and npm strips the first path component whatever it is called, so a tarball
 * that wraps in another name (older packages do) is read the same way. A
 * directory entry with no file anywhere in it installs nothing under npm's
 * strip, so it does not count as a second wrapper (ADR 0058 section 8). A tree
 * whose only entry is a file, or with a file or a second directory that holds
 * one beside the first, is not wrapped. The one rule for a layout's placement
 * and for a path into the tree it placed (the npm layout and opmx's tool
 * layout).
 */
export async function tarballWrapper(
  tree: string,
): Promise<string | undefined> {
  try {
    const kept: Dirent[] = [];
    for (const child of await readdir(tree, { withFileTypes: true }))
      if (!child.isDirectory() || (await holdsFile(join(tree, child.name))))
        kept.push(child);
    const only = kept.length === 1 ? kept[0] : undefined;
    return only?.isDirectory() === true ? only.name : undefined;
  } catch {
    return undefined;
  }
}

/** Whether a file, or anything that is not a directory, is somewhere under `dir`. */
async function holdsFile(dir: string): Promise<boolean> {
  for (const child of await readdir(dir, { withFileTypes: true }))
    if (!child.isDirectory() || (await holdsFile(join(dir, child.name))))
      return true;
  return false;
}
