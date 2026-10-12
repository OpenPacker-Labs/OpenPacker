/**
 * Workspace-member links by project-relative path.
 *
 * `handle-link.ts` works on an open directory. A layout writer thinks in paths
 * (`node_modules/@scope/name`), so these walk down from the project root one
 * directory handle at a time, never following a link and never re-walking a
 * path, and then ask `symlinkChild`, `readlinkChild` or `unlinkChild` to act on
 * the last directory. A scope directory that is missing is made; any component
 * that is a link or not a directory is `UNSAFE_PATH`.
 */

import { constants } from 'node:fs';
import { realpath, type FileHandle } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  readlinkChild,
  symlinkChild,
  unlinkChild,
  type LinkOutcome,
  type LinkSite,
} from './handle-link.js';
import {
  O_DIRECTORY,
  lstatChild,
  mkdirChild,
  openChild,
  readDirChild,
  removeChild,
  windowsReadReparse,
} from './handle-path.js';
import { ProjectIoError } from './index.js';
import { openProjectDirectory } from './layout.js';
import { linkDirectoryProblem, splitLinkPath } from './link-rules.js';

/** What a member link's path holds. */
export type MemberLinkState =
  | { kind: 'absent' }
  | { kind: 'link'; target: string }
  | { kind: 'directory' }
  | { kind: 'file' }
  | { kind: 'other' };

interface Container {
  handle: FileHandle;
  site: LinkSite;
  name: string;
}

function unsafe(path: string, why: string): ProjectIoError {
  return new ProjectIoError('UNSAFE_PATH', path, `${path}: ${why}`);
}

/** The directory that holds `path`, opened without following anything. */
async function openContainer(
  projectRoot: string,
  path: string,
  create: boolean,
): Promise<Container | undefined> {
  const place = splitLinkPath(path);
  if ('problem' in place)
    throw unsafe(path, `not the place of a member link (${place.problem})`);
  const root = await realpath(resolve(projectRoot));
  let handle = await openProjectDirectory(root, false);
  try {
    for (const part of place.directory.split('/')) {
      if (create)
        await mkdirChild(handle, part).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'EEXIST') throw error;
        });
      let next: FileHandle;
      try {
        next = await openChild(
          handle,
          part,
          constants.O_RDONLY | O_DIRECTORY | constants.O_NOFOLLOW,
        );
      } catch (error) {
        // SAFETY: the operations above throw Error values with an optional errno code.
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' && !create) {
          await handle.close();
          return undefined;
        }
        if (code === 'ELOOP' || code === 'ENOTDIR')
          throw unsafe(path, `${part} is a link or not a directory`);
        throw error;
      }
      await handle.close();
      handle = next;
      if (!(await handle.stat()).isDirectory())
        throw unsafe(path, `${part} is not a directory`);
      // Windows opens a junction as itself and not as what it points at, so
      // that open succeeds and says "directory". A component that is a link is
      // refused here, by what it is, whatever NT would then do inside it.
      if (process.platform === 'win32' && windowsReadReparse(handle.fd))
        throw unsafe(path, `${part} is a link`);
    }
    return {
      handle,
      site: { directory: place.directory, projectRoot: root },
      name: place.name,
    };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

/**
 * Make the member link at `path` (project-root relative, `node_modules/name` or
 * `node_modules/@scope/name`, and likewise inside a package's own
 * `node_modules`) point at `target`, the text of the link relative to its
 * directory. The rules and the idempotence are `symlinkChild`'s.
 */
export async function placeMemberLink(
  projectRoot: string,
  path: string,
  target: string,
): Promise<LinkOutcome> {
  const container = await openContainer(projectRoot, path, true);
  // SAFETY: with create set, a missing directory is made, so a container is always returned.
  const { handle, site, name } = container!;
  try {
    return await symlinkChild(handle, name, target, site);
  } finally {
    await handle.close();
  }
}

/** What `path` holds, looked at and not followed. */
export async function readMemberLink(
  projectRoot: string,
  path: string,
): Promise<MemberLinkState> {
  const container = await openContainer(projectRoot, path, false);
  if (container === undefined) return { kind: 'absent' };
  const { handle, site, name } = container;
  try {
    const info = await lstatChild(handle, name).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      },
    );
    if (info === undefined) return { kind: 'absent' };
    if (info.isSymbolicLink())
      return { kind: 'link', target: await readlinkChild(handle, name, site) };
    if (info.isDirectory()) return { kind: 'directory' };
    return info.isFile() ? { kind: 'file' } : { kind: 'other' };
  } finally {
    await handle.close();
  }
}

/**
 * Remove the member link at `path` if it is a link with exactly the text the
 * layout's record says it wrote. Anything else there (a link somebody
 * repointed, a file, a directory) is `kept`: only what was written is removed.
 */
export async function removeMemberLink(
  projectRoot: string,
  path: string,
  recordedTarget: string,
): Promise<'removed' | 'absent' | 'kept'> {
  const state = await readMemberLink(projectRoot, path);
  if (state.kind === 'absent') return 'absent';
  if (state.kind !== 'link' || state.target !== recordedTarget) return 'kept';
  const container = await openContainer(projectRoot, path, false);
  if (container === undefined) return 'absent';
  const { handle, name } = container;
  try {
    await unlinkChild(handle, name);
    return 'removed';
  } catch (error) {
    // SAFETY: the operations above throw Error values with an optional errno code.
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return 'absent';
    // Swapped for something that is not a link between the look and the
    // removal: it is not what was written, so it stays.
    if (code === 'NOT_A_LINK') return 'kept';
    throw error;
  } finally {
    await handle.close();
  }
}

/**
 * Remove the scope directory at `scopePath` (`node_modules/@scope`) if nothing
 * is in it, as the last link of a scope is taken away. A scope with anything in
 * it is left; so is a path that is not a scope directory.
 */
export async function removeEmptyScope(
  projectRoot: string,
  scopePath: string,
): Promise<boolean> {
  const cut = scopePath.lastIndexOf('/');
  const scope = scopePath.slice(cut + 1);
  if (cut <= 0 || !scope.startsWith('@') || linkDirectoryProblem(scopePath))
    throw unsafe(scopePath, 'not a scope directory of a node_modules');
  const container = await openContainer(projectRoot, `${scopePath}/x`, false);
  if (container === undefined) return false;
  const { handle } = container;
  try {
    if ((await readDirChild(handle)).length > 0) return false;
  } finally {
    await handle.close();
  }
  const parent = await openContainer(
    projectRoot,
    `${scopePath.slice(0, cut)}/x`,
    false,
  );
  if (parent === undefined) return false;
  try {
    await removeChild(parent.handle, scope, { recursive: true, force: true });
    return true;
  } finally {
    await parent.handle.close();
  }
}
