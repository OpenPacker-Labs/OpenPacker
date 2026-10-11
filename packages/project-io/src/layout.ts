/**
 * Materialise a directory from the content-addressed store.
 *
 * Copy through stable, no-follow file and directory handles, and never
 * symlink. Pathname-only hardlinks would reopen the source race this boundary
 * exists to close.
 */

import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, type FileHandle } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { ProjectIoError } from './index.js';
import {
  linkChild,
  lstatChild,
  mkdirChild,
  openChild,
  readDirChildWithTypes,
  removeChild,
  renameChild,
  StableHandleError,
  supportsStableHandles,
} from './handle-path.js';
import { linkVerified, type LinkState } from './layout-hardlink.js';
import {
  openDirectoryAt,
  openProjectDirectory,
  unsafe,
} from './stable-open.js';
import {
  assertTreeSnapshot,
  sameMetadata,
  snapshot,
  type TreeEntrySnapshot,
} from './tree-snapshot.js';

export interface MaterialiseOptions {
  /**
   * Hard-link each file from `source` instead of copying its bytes.
   *
   * The linked entry must be the very inode that was opened and inspected
   * through the source directory handle; a name that was swapped between the
   * inspection and the link is refused, never kept. A filesystem that cannot
   * link (another device, a platform without handle-relative links, a file
   * system that refuses) falls back to a verified copy for the rest of the
   * tree, and `copied` says so. Linked files share their inode with the
   * source, so their mode is the source's and is never changed from here.
   */
  link?: boolean;
}

export interface MaterialiseOptions {
  /**
   * Hard-link each file from `source` instead of copying its bytes.
   *
   * The linked entry must be the very inode that was opened and inspected
   * through the source directory handle; a name that was swapped between the
   * inspection and the link is refused, never kept. A filesystem that cannot
   * link (another device, a platform without handle-relative links, a file
   * system that refuses) falls back to a verified copy for the rest of the
   * tree, and `copied` says so. Linked files share their inode with the
   * source, so their mode is the source's and is never changed from here.
   */
  link?: boolean;
}

export interface MaterialiseResult {
  /** Files linked or copied. */
  files: number;
  /** Of `files`, how many are hard links to the source rather than copies. */
  linked: number;
  /** True when at least one file had to be copied rather than linked. */
  copied: boolean;
}

/**
 * Replace `destination` with the contents of `source`.
 *
 * Replace, not merge: a layout that accumulates files from a previous
 * resolution is a layout nobody can reason about.
 */
export async function materialiseTree(
  source: string,
  destination: string,
  root: string,
  options: MaterialiseOptions = {},
): Promise<MaterialiseResult> {
  assertContained(root, destination);
  const rootHandle = await openProjectDirectory(root, true);
  const handles: FileHandle[] = [rootHandle];
  const result: MaterialiseResult = { files: 0, linked: 0, copied: false };
  const link: LinkState | undefined =
    options.link === true ? { unavailable: false } : undefined;
  let staging: string | undefined;
  let stagingParent = rootHandle;
  try {
    const parts = relative(resolve(root), resolve(destination)).split(sep);
    const name = parts.pop();
    if (!name || name === '.' || name === '..') throw unsafe(destination);
    let parent = rootHandle;
    for (const part of parts) {
      if (!part || part === '.' || part === '..') throw unsafe(destination);
      await mkdirChild(parent, part).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
      });
      parent = await openDirectoryAt(parent, part);
      handles.push(parent);
      stagingParent = parent;
    }

    const stagingName = `.${name}.openpacker-${randomUUID()}`;
    staging = stagingName;
    await mkdirChild(parent, stagingName);
    const stagingHandle = await openDirectoryAt(parent, stagingName);
    handles.push(stagingHandle);
    const sourceHandle = await openProjectDirectory(source, false);
    handles.push(sourceHandle);
    const sourceSnapshot = new Map<string, TreeEntrySnapshot>();
    const stagedSnapshot = new Map<string, TreeEntrySnapshot>();
    await walk(
      sourceHandle,
      stagingHandle,
      result,
      '',
      sourceSnapshot,
      stagedSnapshot,
      link,
    );
    await assertTreeSnapshot(sourceHandle, sourceSnapshot);
    await assertTreeSnapshot(stagingHandle, stagedSnapshot);
    const publishedLexical = resolve(destination);
    await removeChild(parent, name, { recursive: true, force: true });
    await assertTreeSnapshot(sourceHandle, sourceSnapshot);
    await assertTreeSnapshot(stagingHandle, stagedSnapshot);
    await renameChild(parent, stagingName, name);
    staging = undefined;
    try {
      await assertNamedHandle(publishedLexical, stagingHandle);
      await assertTreeSnapshot(sourceHandle, sourceSnapshot);
      stagedSnapshot.set(
        '',
        snapshot('directory', await stagingHandle.stat({ bigint: true })),
      );
      await assertTreeSnapshot(stagingHandle, stagedSnapshot);
    } catch (error) {
      await removeChild(parent, name, { recursive: true, force: true }).catch(
        () => undefined,
      );
      throw error;
    }
    return result;
  } catch (error) {
    if (
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      (error as NodeJS.ErrnoException).code === 'ELOOP' ||
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      (error as NodeJS.ErrnoException).code === 'ENOTDIR' ||
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    )
      throw unsafe(destination);
    throw error;
  } finally {
    if (staging)
      await removeChild(stagingParent, staging, {
        recursive: true,
        force: true,
      }).catch(() => undefined);
    await Promise.all(
      handles.reverse().map(async (handle) => await handle.close()),
    );
  }
}

async function walk(
  source: FileHandle,
  destination: FileHandle,
  result: MaterialiseResult,
  at: string,
  sourceSnapshot: Map<string, TreeEntrySnapshot>,
  destinationSnapshot: Map<string, TreeEntrySnapshot>,
  link: LinkState | undefined,
): Promise<void> {
  const sourceDirectoryBefore = await source.stat({ bigint: true });
  const entries = await readDirChildWithTypes(source);
  for (const entry of entries) {
    const relativePath = at === '' ? entry.name : `${at}/${entry.name}`;
    if (entry.isDirectory()) {
      const fromHandle = await openDirectoryAt(source, entry.name);
      await mkdirChild(destination, entry.name);
      const toHandle = await openDirectoryAt(destination, entry.name);
      try {
        await walk(
          fromHandle,
          toHandle,
          result,
          relativePath,
          sourceSnapshot,
          destinationSnapshot,
          link,
        );
      } finally {
        await Promise.all([fromHandle.close(), toHandle.close()]);
      }
      continue;
    }
    if (!entry.isFile()) {
      // The store is built by the materializer, which already refuses
      // symlinks, devices and sockets. Anything else here is not something to
      // reproduce into a project directory on a guess.
      throw unsafe(relativePath);
    }
    const file = await openChild(
      source,
      entry.name,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
    let output: FileHandle | undefined;
    try {
      const before = await file.stat({ bigint: true });
      if (!before.isFile()) throw unsafe(relativePath);
      if (before.size > BigInt(Number.MAX_SAFE_INTEGER))
        throw unsafe(relativePath);
      if (
        link &&
        !link.unavailable &&
        (await linkVerified({
          source,
          destination,
          name: entry.name,
          file,
          before,
          relativePath,
          link,
          sourceSnapshot,
          destinationSnapshot,
        }))
      ) {
        result.files += 1;
        result.linked += 1;
        continue;
      }
      const size = Number(before.size);
      output = await openChild(
        destination,
        entry.name,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        (before.mode & 0o111n) !== 0n ? 0o755 : 0o644,
      );
      const buffer = new Uint8Array(64 * 1024);
      let offset = 0;
      while (offset < size) {
        const length = Math.min(size - offset, buffer.byteLength);
        const { bytesRead } = await file.read(buffer, 0, length, offset);
        if (bytesRead === 0) break;
        await output.write(buffer, 0, bytesRead, offset);
        offset += bytesRead;
      }
      await output.sync();
      const [after, outputInfo, namedOutput] = await Promise.all([
        file.stat({ bigint: true }),
        output.stat({ bigint: true }),
        lstatChild(destination, entry.name),
      ]);
      if (
        BigInt(offset) !== before.size ||
        after.dev !== before.dev ||
        after.ino !== before.ino ||
        after.size !== before.size ||
        after.ctimeNs !== before.ctimeNs ||
        after.mtimeNs !== before.mtimeNs ||
        outputInfo.dev !== namedOutput.dev ||
        outputInfo.ino !== namedOutput.ino
      )
        throw unsafe(relativePath);
      await output.chmod((before.mode & 0o111n) !== 0n ? 0o755 : 0o644);
      const finalOutput = await output.stat({ bigint: true });
      destinationSnapshot.set(relativePath, snapshot('file', finalOutput));
      sourceSnapshot.set(relativePath, snapshot('file', before));
      result.copied = true;
    } finally {
      await output?.close().catch(() => undefined);
      await file.close();
    }
    result.files += 1;
  }
  const sourceDirectoryAfter = await source.stat({ bigint: true });
  if (!sameMetadata(sourceDirectoryBefore, sourceDirectoryAfter))
    throw unsafe(at || '<source>');
  sourceSnapshot.set(at, snapshot('directory', sourceDirectoryBefore));
  destinationSnapshot.set(
    at,
    snapshot('directory', await destination.stat({ bigint: true })),
  );
}

async function assertNamedHandle(
  path: string,
  handle: FileHandle,
): Promise<void> {
  const [opened, named] = await Promise.all([
    handle.stat({ bigint: true }),
    lstat(path, { bigint: true }),
  ]);
  if (opened.dev !== named.dev || opened.ino !== named.ino) throw unsafe(path);
}

export function supportsStableTreeLayout(
  platform: NodeJS.Platform = process.platform,
): boolean {
  return supportsStableHandles(platform);
}

/**
 * Refuse a destination outside its root.
 *
 * The path is built from a package name that came off a registry, and what
 * happens next is a recursive delete followed by a write. `@evil/../../..` has
 * to stop here.
 */
function assertContained(root: string, destination: string): void {
  const base = resolve(root);
  const target = resolve(destination);
  if (target !== base && !target.startsWith(base + sep))
    throw new ProjectIoError(
      'UNSAFE_PATH',
      destination,
      `Layout destination escapes ${base}: ${destination}`,
    );
}

/** Remove a layout directory if it exists. */
export async function removeTree(path: string): Promise<void> {
  const parent = await openProjectDirectory(dirname(resolve(path)), false);
  try {
    await removeChild(parent, resolve(path).split(sep).at(-1)!, {
      recursive: true,
      force: true,
    });
  } finally {
    await parent.close();
  }
}
