/**
 * The user-level package store shared by every project on a machine.
 *
 * A package's files exist once, in `<root>/sha256-<archive digest>/`; each
 * project's `.opm/store` entry is a tree of hard links to them, and a layout
 * written from that store (`node_modules`) links again. A second project, or
 * a second worktree of the same repository, costs directories and links, not
 * bytes.
 *
 * What makes that safe:
 *
 * - The root is private to the user: created `0700`, owned by the current
 *   user, never group- or world-writable. An entry's recorded tree digest
 *   catches corruption, not tampering, so nobody else may write here.
 * - An entry is re-hashed every time a project adopts it, and the project's
 *   own linked tree is hashed again, so a file edited in place through any
 *   link is found before it is trusted.
 * - Entry files are read-only, so the in-place edit that would corrupt every
 *   project fails loudly instead of silently succeeding.
 * - A package whose lifecycle scripts run gets private copies of its files
 *   first, so a script can never write through a link into the store.
 * - Only `opm gc --shared` ever removes an entry, and only one no project
 *   links to.
 */

import { createHash, randomUUID } from 'node:crypto';
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
import { constants } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  descriptorForBytes,
  streamFromBytes,
  type ArtifactSource,
} from '@openpacker/artifact-model';
import { materialize, type ArchiveFormat } from '@openpacker/materializer';
import { assertHandleSegment, StableHandleError } from '@openpacker/project-io';
import { stableStoreTreeDigest } from './generations.js';
import { OpmError } from './types.js';
import {
  assertDigest,
  ensureStableDirectory,
  openChild,
  openStableDirectory,
  readDirChildWithTypes,
  readStableFile,
  removeStableTree,
  storeKeyFromDigest,
  writeStableFile,
} from './paths.js';

import {
  enableDefaultSharedStore,
  sharedStoreRoot,
  usableSharedRoot,
} from './shared-store-root.js';

export { enableDefaultSharedStore, sharedStoreRoot, usableSharedRoot };

export async function materializeThroughSharedStore(input: {
  digest: string;
  projectStorePath: string;
  bytes: Uint8Array | (() => Promise<Uint8Array>);
  format: ArchiveFormat;
  env?: NodeJS.ProcessEnv;
  /** Already resolved by the caller; skips resolving it again. */
  sharedRoot?: string;
  linkFile?: (existingPath: string, newPath: string) => Promise<void>;
}): Promise<{ path: string; shared: boolean; treeDigest?: string }> {
  const digest = assertDigest(input.digest);
  const projectStorePath = input.projectStorePath;
  const format = input.format;
  const linkFile = input.linkFile ?? hardlinkFile;
  const sharedRoot =
    input.sharedRoot ?? (await usableSharedRoot(projectStorePath, input.env));
  if (sharedRoot === undefined) {
    const bytes = await resolveBytes(input.bytes, digest);
    await materializeArchive(bytes, format, digest, projectStorePath);
    return { path: projectStorePath, shared: false };
  }

  // A concurrent `opm gc --shared` can unpublish an entry between publishing
  // it and linking from it. That is a retry, not a failure.
  for (let attempt = 0; ; attempt += 1) {
    const published = await publishSharedEntry({
      sharedRoot,
      digest,
      format,
      bytes: input.bytes,
    });
    try {
      await linkTree(published.path, projectStorePath, linkFile);
      const projectDigest = await stableStoreTreeDigest(projectStorePath);
      if (projectDigest !== published.treeDigest)
        throw new OpmError(
          'VERIFICATION_FAILED',
          `Project store tree for ${digest} does not match the shared entry`,
        );
      return {
        path: projectStorePath,
        shared: true,
        treeDigest: published.treeDigest,
      };
    } catch (error) {
      await rm(projectStorePath, { recursive: true, force: true }).catch(
        () => undefined,
      );
      if (attempt === 0 && isMissing(error)) continue;
      throw error;
    }
  }
}

function isMissing(error: unknown): boolean {
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

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

async function publishSharedEntry(input: {
  sharedRoot: string;
  digest: string;
  format: ArchiveFormat;
  bytes: Uint8Array | (() => Promise<Uint8Array>);
}): Promise<{ path: string; treeDigest: string }> {
  const storeKey = storeKeyFromDigest(input.digest);
  const sharedPath = join(input.sharedRoot, storeKey);
  // Two projects installing the same new package at once both materialize it;
  // one rename wins, and the loser adopts what the winner published.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const existing = await adoptExistingEntry(sharedPath, input.digest);
    if (existing !== undefined)
      return { path: sharedPath, treeDigest: existing };

    const bytes = await resolveBytes(input.bytes, input.digest);
    const tmp = join(
      input.sharedRoot,
      `.${storeKey}.materialize-${randomUUID()}`,
    );
    try {
      await materializeArchive(bytes, input.format, input.digest, tmp);
      const treeDigest = await stableStoreTreeDigest(tmp);
      await sealTreeReadOnly(tmp);
      await recordTreeDigest(sharedPath, treeDigest);
      try {
        await rename(tmp, sharedPath);
      } catch (error) {
        // SAFETY: The surrounding boundary establishes the asserted domain contract.
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOTEMPTY' || code === 'EEXIST') {
          await removeStableTree(tmp).catch(() => undefined);
          continue;
        }
        throw error;
      }
      return { path: sharedPath, treeDigest };
    } catch (error) {
      await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }
  throw new OpmError(
    'VERIFICATION_FAILED',
    `Shared store entry for ${input.digest} kept changing while it was published`,
  );
}

/**
 * Write the digest an entry's tree must hash to.
 *
 * Two installs publishing the same package write the same bytes here, and the
 * second one's atomic replace finds a different inode than it wrote. Same
 * content is not a conflict; different content is.
 */
async function recordTreeDigest(
  sharedPath: string,
  treeDigest: string,
): Promise<void> {
  const record = `${treeDigest}\n`;
  try {
    await writeStableFile(`${sharedPath}.tree`, record);
  } catch (error) {
    if (
      !(error instanceof OpmError && error.code === 'INPUT_CHANGED') ||
      (await readStableFile(`${sharedPath}.tree`).catch(() => '')) !== record
    )
      throw error;
  }
}

/** The recorded tree digest of an entry that is there and intact, else undefined. */
async function adoptExistingEntry(
  sharedPath: string,
  digest: string,
): Promise<string | undefined> {
  const existing = await lstat(sharedPath).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    },
  );
  if (existing === undefined) return undefined;
  if (existing.isSymbolicLink() || !existing.isDirectory())
    throw new OpmError(
      'UNSAFE_PATH',
      `Shared store entry is linked or not a directory: ${sharedPath}`,
    );
  await assertNoFollowTree(sharedPath);
  const recorded = await readRecordedTreeDigest(sharedPath);
  const actual = await stableStoreTreeDigest(sharedPath);
  if (actual !== recorded)
    throw new OpmError(
      'VERIFICATION_FAILED',
      `Shared store tree for ${digest} does not match its recorded digest; ` +
        `remove ${sharedPath} and ${sharedPath}.tree and run the command again`,
    );
  return actual;
}

async function readRecordedTreeDigest(sharedPath: string): Promise<string> {
  let text: string;
  try {
    text = await readStableFile(`${sharedPath}.tree`);
  } catch (error) {
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new OpmError(
        'VERIFICATION_FAILED',
        `Shared store entry is missing its tree digest: ${sharedPath}`,
      );
    throw error;
  }
  const recorded = text.trim();
  if (!/^sha256:[0-9a-f]{64}$/u.test(recorded))
    throw new OpmError(
      'VERIFICATION_FAILED',
      `Shared store tree digest is malformed: ${sharedPath}`,
    );
  return recorded;
}

async function resolveBytes(
  bytes: Uint8Array | (() => Promise<Uint8Array>),
  digest: string,
): Promise<Uint8Array> {
  const value = typeof bytes === 'function' ? await bytes() : bytes;
  const actual = digestOf(value);
  if (actual !== digest)
    throw new OpmError(
      'DIGEST_MISMATCH',
      `Shared store digest mismatch: expected ${digest}, got ${actual}`,
    );
  return value;
}

async function materializeArchive(
  bytes: Uint8Array,
  format: ArchiveFormat,
  digest: string,
  destination: string,
): Promise<void> {
  await ensureStableDirectory(dirname(destination));
  const descriptor = await descriptorForBytes({
    bytes,
    descriptorId: storeKeyFromDigest(digest),
    mediaType: mediaTypeForFormat(format),
    artifactType: 'package',
    nativeRole: 'native-package',
  });
  await materialize({
    source: bytesSource(bytes),
    descriptor,
    destination,
    format,
  });
}

function bytesSource(bytes: Uint8Array): ArtifactSource {
  return {
    async stat(descriptor) {
      return { descriptor, rangeSupported: false };
    },
    async open() {
      return streamFromBytes(bytes);
    },
    async listReferrers() {
      return [];
    },
  };
}

function digestOf(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function mediaTypeForFormat(format: ArchiveFormat): string {
  switch (format) {
    case 'tar':
      return 'application/x-tar';
    case 'tar+gzip':
      return 'application/gzip';
    case 'zip':
      return 'application/zip';
  }
}

async function hardlinkFile(
  existingPath: string,
  newPath: string,
): Promise<void> {
  await link(existingPath, newPath);
}

async function linkTree(
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

async function assertNoFollowTree(root: string): Promise<void> {
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
