import { readdir } from 'node:fs/promises';

/**
 * The one directory a package's extracted tree wraps its files in, if any.
 *
 * npm tarballs wrap their contents in one directory, `package/` by convention,
 * and npm strips the first path component whatever it is called, so a tarball
 * that wraps in another name (older packages do) is read the same way. A tree
 * whose only entry is a file, or that has several, is not wrapped. The one rule
 * for a layout's placement and for a path into the tree it placed.
 */
export async function tarballWrapper(
  tree: string,
): Promise<string | undefined> {
  try {
    const children = await readdir(tree, { withFileTypes: true });
    const only = children.length === 1 ? children[0] : undefined;
    return only?.isDirectory() === true ? only.name : undefined;
  } catch {
    return undefined;
  }
}
