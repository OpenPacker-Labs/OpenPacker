/**
 * Remove a directory below the project root, walking down to it without
 * following a link.
 *
 * `removeTree` takes a path, and canonicalizes the ancestors it finds: a
 * directory that was swapped for a link to somewhere else is followed, and what
 * is removed is the other place's. A frozen install of a workspace removes each
 * member's `node_modules`, and a member's directory comes from a lock, so this
 * walks from the project root one directory handle at a time (as the member-link
 * code does) and refuses a link or a file on the way. The last component is
 * removed as itself: a link there is unlinked, never entered.
 */

import { ProjectIoError } from './index.js';
import { removeChild } from './handle-path.js';
import { openProjectDirectory, stepPlainDirectory } from './stable-open.js';

/**
 * Remove `relativePath` (`/`-separated, no `.`, `..` or empty segment) below
 * `projectRoot`. Resolves to false when nothing was there to remove, true when
 * something was. A component above the last that is a link, or not a directory,
 * is `UNSAFE_PATH` and nothing is removed.
 */
export async function removeBelow(
  projectRoot: string,
  relativePath: string,
): Promise<boolean> {
  const parts = relativePath.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..'))
    throw new ProjectIoError(
      'UNSAFE_PATH',
      relativePath,
      `${JSON.stringify(relativePath)} is not a path below the project root`,
    );
  let handle = await openProjectDirectory(projectRoot, false);
  try {
    for (const part of parts.slice(0, -1)) {
      const step = await stepPlainDirectory(handle, part);
      if (step.kind === 'missing') return false;
      if (step.kind !== 'directory')
        throw new ProjectIoError(
          'UNSAFE_PATH',
          relativePath,
          `${part} on the way to ${relativePath} is a link or not a directory`,
        );
      await handle.close();
      handle = step.handle;
    }
    const last = parts.at(-1)!;
    try {
      await removeChild(handle, last, { recursive: true, force: false });
      return true;
    } catch (error) {
      // SAFETY: the operations above throw Error values with an optional errno code.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  } finally {
    await handle.close();
  }
}
