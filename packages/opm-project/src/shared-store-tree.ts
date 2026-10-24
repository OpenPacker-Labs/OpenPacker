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
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  rename,
  rm,
  unlink,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { assertHandleSegment, StableHandleError } from '@openpacker/project-io';
import { OpmError } from './types.js';
import {
  ensureStableDirectory,
  openChild,
  openStableDirectory,
  readDirChildWithTypes,
} from './paths.js';

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
      const info = await lstat(path);
      if (info.nlink <= 1) continue;
      const tmp = `${path}.copy-${randomUUID()}`;
      try {
        await copyFile(path, tmp);
        await chmod(tmp, (info.mode & 0o777) | 0o200);
        await unlink(path);
        await rename(tmp, path);
      } catch (error) {
        await rm(tmp, { force: true }).catch(() => undefined);
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
export async function hardlinkFile(
  existingPath: string,
  newPath: string,
): Promise<void> {
  await link(existingPath, newPath);
}

export async function linkTree(
  source: string,
  destination: string,
  linkFile: (existingPath: string, newPath: string) => Promise<void>,
): Promise<void> {
  await ensureStableDirectory(dirname(destination));
  await mkdir(destination);
  const handle = await openStableDirectory(source);
  try {
    await linkEntries(source, destination, linkFile);
  } finally {
    await handle.close();
  }
}

async function linkEntries(
  source: string,
  destination: string,
  linkFile: (existingPath: string, newPath: string) => Promise<void>,
): Promise<void> {
  const handle = await openStableDirectory(source);
  try {
    const entries = await readDirChildWithTypes(handle);
    for (const entry of entries) {
      assertEntryName(entry.name);
      const from = join(source, entry.name);
      const to = join(destination, entry.name);
      if (entry.isSymbolicLink())
        throw new OpmError(
          'UNSAFE_PATH',
          `Shared store entry is a symbolic link: ${from}`,
        );
      if (entry.isDirectory()) {
        await mkdir(to);
        await linkEntries(from, to, linkFile);
        continue;
      }
      if (!entry.isFile())
        throw new OpmError(
          'UNSAFE_PATH',
          `Shared store entry is not a regular file: ${from}`,
        );
      await publishFile(from, to, linkFile);
    }
  } finally {
    await handle.close();
  }
}

async function publishFile(
  from: string,
  to: string,
  linkFile: (existingPath: string, newPath: string) => Promise<void>,
): Promise<void> {
  try {
    await linkFile(from, to);
  } catch (error) {
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    await copyFile(from, to);
    const mode = (await lstat(from)).mode;
    // A copy is the project's own file, so it stays writable.
    await chmod(to, (mode & 0o777) | 0o200);
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
