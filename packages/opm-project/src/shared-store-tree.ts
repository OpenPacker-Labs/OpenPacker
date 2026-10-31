/**
 * Walking a package tree of the shared store: linking it into a project,
 * breaking those links again, sealing it read-only, and refusing anything in
 * it that is not a plain directory or file.
 *
 * Kept apart from the store's publishing and adoption (`shared-store.ts`),
 * which these walks serve.
 */

import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, type FileHandle } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  assertHandleSegment,
  lstatChild,
  StableHandleError,
} from '@openpacker/project-io';
import { OpmError } from './types.js';
import {
  ensureStableDirectory,
  mkdirChild,
  openChild,
  openStableDirectory,
  readDirChildWithTypes,
  removeChild,
  renameChild,
} from './paths.js';
import { copyChild, linkVerified } from './stable-ops.js';

/**
 * Break hardlinks in a project store tree so later writes (lifecycle scripts)
 * cannot mutate the shared CAS inodes they were linked from. The copies are
 * writable: the point is that the script may write to them.
 */
export async function isolateProjectStoreFromSharedLinks(
  projectStorePath: string,
): Promise<void> {
  await isolateEntries(projectStorePath);
}

async function isolateEntries(root: string): Promise<void> {
  const handle = await openStableDirectory(root);
  try {
    const entries = await readDirChildWithTypes(handle);
    for (const entry of entries) {
      assertEntryName(entry.name);
      const path = join(root, entry.name);
      if (entry.isSymbolicLink())
        throw new OpmError(
          'UNSAFE_PATH',
          `Project store entry is a symbolic link: ${path}`,
        );
      if (entry.isDirectory()) {
        await isolateEntries(path);
        continue;
      }
      if (!entry.isFile())
        throw new OpmError(
          'UNSAFE_PATH',
          `Project store entry is not a regular file: ${path}`,
        );
      // Every step is relative to the directory's handle, so a component of
      // `root` swapped for a link since it was opened redirects none of them.
      const info = await lstatChild(handle, entry.name);
      if (!info.isFile() || info.nlink <= 1n) continue;
      const tmp = `${entry.name}.copy-${randomUUID()}`;
      try {
        // Writable by its owner, whatever the store's file was: a script
        // that edits its own file must be able to (ADR 0034, as main had it).
        await copyChild(handle, entry.name, handle, tmp, {
          mode: (Number(info.mode) & 0o777) | 0o200,
        });
        await removeChild(handle, entry.name);
        await renameChild(handle, tmp, entry.name);
      } catch (error) {
        await removeChild(handle, tmp, { force: true }).catch(() => undefined);
        throw error;
      }
    }
  } finally {
    await handle.close();
  }
}

/**
 * A name inside a package tree.
 *
 * The materializer already refused everything unsafe about an archive's paths
 * (traversal, absolute paths, Windows device names, links), and every access
 * below goes through an open directory handle, so what is checked here is only
 * that a name is one path segment. A package may legitimately ship `[id].js`,
 * `+page.svelte` or `README (copy).md`.
 */
export function assertEntryName(name: string): void {
  try {
    assertHandleSegment(name);
  } catch (error) {
    if (error instanceof StableHandleError)
      throw new OpmError('UNSAFE_PATH', `Invalid store entry "${name}"`);
    throw error;
  }
}
/**
 * Hard-link every file of `source` into `destination`, a directory made here.
 *
 * Both trees are walked through handles opened one no-follow component at a
 * time. A file is linked relative to the two directories' handles under a
 * temporary name, and given its own only once it is proved to be the very
 * file inspected in `source` (`linkVerified`); a copy (another file system,
 * or Windows) is written through the handles.
 */
export async function linkTree(
  source: string,
  destination: string,
  linkFile?: (existingPath: string, newPath: string) => Promise<void>,
): Promise<void> {
  await ensureStableDirectory(dirname(destination));
  const parent = await openStableDirectory(dirname(destination));
  try {
    await mkdirChild(parent, basename(destination));
  } finally {
    await parent.close();
  }
  await linkEntries(source, destination, linkFile);
}

async function linkEntries(
  source: string,
  destination: string,
  linkFile:
    | ((existingPath: string, newPath: string) => Promise<void>)
    | undefined,
): Promise<void> {
  const from = await openStableDirectory(source);
  try {
    const to = await openStableDirectory(destination);
    try {
      for (const entry of await readDirChildWithTypes(from)) {
        assertEntryName(entry.name);
        const path = join(source, entry.name);
        if (entry.isSymbolicLink())
          throw new OpmError(
            'UNSAFE_PATH',
            `Shared store entry is a symbolic link: ${path}`,
          );
        if (entry.isDirectory()) {
          await mkdirChild(to, entry.name);
          await linkEntries(path, join(destination, entry.name), linkFile);
          continue;
        }
        if (!entry.isFile())
          throw new OpmError(
            'UNSAFE_PATH',
            `Shared store entry is not a regular file: ${path}`,
          );
        await publishFile(from, to, entry.name, {
          from: path,
          to: join(destination, entry.name),
          linkFile,
        });
      }
    } finally {
      await to.close();
    }
  } finally {
    await from.close();
  }
}

async function publishFile(
  from: FileHandle,
  to: FileHandle,
  name: string,
  paths: {
    from: string;
    to: string;
    linkFile:
      | ((existingPath: string, newPath: string) => Promise<void>)
      | undefined;
  },
): Promise<void> {
  const before = await lstatChild(from, name);
  try {
    if (paths.linkFile === undefined) {
      // Through the two directories' handles on every platform that has a
      // handle-relative link, proved to be the inspected file before it is
      // given its name (`linkVerified`); Windows copies (EXDEV).
      await linkVerified(from, name, before, to, name, paths.from);
      return;
    }
    await paths.linkFile(paths.from, paths.to);
  } catch (error) {
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    // A copy is the project's own file, so it stays writable.
    await copyChild(from, name, to, name, {
      mode: (Number(before.mode) & 0o777) | 0o200,
    });
    return;
  }
  // The injected link (a test's) was made by path: it must have made the
  // very file inspected, or it is removed and refused.
  const placed = await lstatChild(to, name).catch(() => undefined);
  if (
    placed?.isFile() !== true ||
    placed.dev !== before.dev ||
    placed.ino !== before.ino
  ) {
    await removeChild(to, name, { force: true }).catch(() => undefined);
    throw new OpmError(
      'INPUT_CHANGED',
      `Shared store entry changed while it was linked into the project: ${paths.to}`,
    );
  }
}

export async function assertNoFollowTree(root: string): Promise<void> {
  const handle = await openStableDirectory(root);
  try {
    await assertNoFollowEntries(root);
  } catch (error) {
    if (
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      (error as NodeJS.ErrnoException).code === 'ELOOP' ||
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      (error as NodeJS.ErrnoException).code === 'ENOTDIR'
    )
      throw new OpmError(
        'UNSAFE_PATH',
        `Shared store entry is linked or unstable: ${root}`,
      );
    throw error;
  } finally {
    await handle.close();
  }
}

async function assertNoFollowEntries(root: string): Promise<void> {
  const handle = await openStableDirectory(root);
  try {
    const entries = await readDirChildWithTypes(handle);
    for (const entry of entries) {
      assertEntryName(entry.name);
      const child = join(root, entry.name);
      if (entry.isSymbolicLink())
        throw new OpmError(
          'UNSAFE_PATH',
          `Shared store entry is a symbolic link: ${child}`,
        );
      if (entry.isDirectory()) {
        await assertNoFollowEntries(child);
        continue;
      }
      if (!entry.isFile())
        throw new OpmError(
          'UNSAFE_PATH',
          `Shared store entry is not a regular file: ${child}`,
        );
      const file = await lstat(child);
      if (file.isSymbolicLink() || !file.isFile())
        throw new OpmError(
          'UNSAFE_PATH',
          `Shared store entry is linked or not a regular file: ${child}`,
        );
    }
  } finally {
    await handle.close();
  }
}

/**
 * Drop the write bits of every file in a tree (POSIX).
 *
 * Every project's `node_modules` file is one of these inodes, so an editor or
 * script that writes one in place would change them all. A read-only file
 * turns that into an error for the person who tried. It is a guard, not a
 * boundary — the owner can still `chmod` — and the digest re-check on
 * adoption is what actually catches a file that was changed anyway.
 */
export async function sealTreeReadOnly(root: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await openStableDirectory(root);
  try {
    for (const entry of await readDirChildWithTypes(handle)) {
      assertEntryName(entry.name);
      if (entry.isDirectory()) {
        await sealTreeReadOnly(join(root, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      const file = await openChild(
        handle,
        entry.name,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const info = await file.stat();
        await file.chmod(info.mode & 0o555);
      } finally {
        await file.close();
      }
    }
  } finally {
    await handle.close();
  }
}
