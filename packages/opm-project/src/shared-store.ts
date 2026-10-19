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
import { lstat, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  descriptorForBytes,
  streamFromBytes,
  type ArtifactSource,
} from '@openpacker/artifact-model';
import {
  materialize,
  type ArchiveFormat,
  type MaterializationLimits,
} from '@openpacker/materializer';
import { stableStoreTreeDigest } from './generations.js';
import { holdSharedStore } from './shared-store-lease.js';
import { OpmError } from './types.js';
import {
  assertDigest,
  ensureStableDirectory,
  readStableFile,
  removeStableTree,
  storeKeyFromDigest,
  writeStableFile,
} from './paths.js';
import {
  assertNoFollowTree,
  hardlinkFile,
  linkTree,
  sealTreeReadOnly,
} from './shared-store-tree.js';

import {
  enableDefaultSharedStore,
  sharedStoreRoot,
  usableSharedRoot,
} from './shared-store-root.js';

export { enableDefaultSharedStore, sharedStoreRoot, usableSharedRoot };
export {
  assertEntryName,
  isolateProjectStoreFromSharedLinks,
  sealTreeReadOnly,
} from './shared-store-tree.js';

export async function materializeThroughSharedStore(input: {
  digest: string;
  projectStorePath: string;
  bytes: Uint8Array | (() => Promise<Uint8Array>);
  format: ArchiveFormat;
  env?: NodeJS.ProcessEnv;
  /** Already resolved by the caller; skips resolving it again. */
  sharedRoot?: string;
  linkFile?: (existingPath: string, newPath: string) => Promise<void>;
  /** Bounds the archive is extracted under; the materializer's by default. */
  limits?: MaterializationLimits;
}): Promise<{ path: string; shared: boolean; treeDigest?: string }> {
  const digest = assertDigest(input.digest);
  const projectStorePath = input.projectStorePath;
  const format = input.format;
  const linkFile = input.linkFile ?? hardlinkFile;
  const sharedRoot =
    input.sharedRoot ?? (await usableSharedRoot(projectStorePath, input.env));
  if (sharedRoot === undefined) {
    const bytes = await resolveBytes(input.bytes, digest);
    await materializeArchive(
      bytes,
      format,
      digest,
      projectStorePath,
      input.limits,
    );
    return { path: projectStorePath, shared: false };
  }

  // The claim keeps `opm gc --shared` away from the entry until this project's
  // links hold it (ADR 0048, amendment 2026-10-17). A remover that does not
  // honour claims can still unpublish it between publishing and linking: that
  // is published again, once.
  const hold = await holdSharedStore(sharedRoot);
  try {
    await hold.claim(storeKeyFromDigest(digest));
    for (let attempt = 0; ; attempt += 1) {
      const published = await publishSharedEntry({
        sharedRoot,
        digest,
        format,
        bytes: input.bytes,
        ...(input.limits !== undefined && { limits: input.limits }),
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
        if (!isMissing(error)) throw error;
        if (attempt === 0) continue;
        throw new OpmError(
          'STORE_ENTRY_VANISHED',
          `The shared store entry ${published.path} was removed again while it was linked into ${projectStorePath}`,
          { cause: error },
        );
      }
    }
  } finally {
    await hold.release();
  }
}

function isMissing(error: unknown): boolean {
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/**
 * Make sure the shared store holds the package whose archive hashes to
 * `digest`, extracting `bytes` if it does not, and return where it is.
 *
 * `seal: false` leaves the files writable. The shared store always seals; a
 * private scratch store (a project that opted out of sharing) is only a place
 * to extract into before linking, and what it links must stay editable.
 */
export async function publishSharedEntry(input: {
  sharedRoot: string;
  digest: string;
  format: ArchiveFormat;
  bytes: Uint8Array | (() => Promise<Uint8Array>);
  seal?: boolean;
  /** Bounds the archive is extracted under; the materializer's by default. */
  limits?: MaterializationLimits;
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
      await materializeArchive(
        bytes,
        input.format,
        input.digest,
        tmp,
        input.limits,
      );
      const treeDigest = await stableStoreTreeDigest(tmp);
      if (input.seal !== false) await sealTreeReadOnly(tmp);
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
 * The entry for `digest` if the store has it and its tree still hashes to what
 * was recorded; undefined if it is not there. A tree that does not match is an
 * error, never a miss: it names the entry to remove.
 */
export async function adoptSharedEntry(
  sharedRoot: string,
  digest: string,
): Promise<{ path: string; treeDigest: string } | undefined> {
  const path = join(sharedRoot, storeKeyFromDigest(assertDigest(digest)));
  const treeDigest = await adoptExistingEntry(path, digest);
  return treeDigest === undefined ? undefined : { path, treeDigest };
}

/**
 * Write the digest an entry's tree must hash to.
 *
 * Two installs publishing the same package write the same bytes here, and the
 * second one's atomic replace finds a different inode than it wrote. Same
 * content is not a conflict; different content is.
 */
export async function recordTreeDigest(
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
export async function adoptExistingEntry(
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
        `Shared store entry is missing its tree digest: ${sharedPath}; ` +
          `remove ${sharedPath} and run the command again`,
      );
    throw error;
  }
  const recorded = text.trim();
  if (!/^sha256:[0-9a-f]{64}$/u.test(recorded))
    throw new OpmError(
      'VERIFICATION_FAILED',
      `Shared store tree digest is malformed: ${sharedPath}.tree is not a sha256 digest; a crash cannot leave this (a record is written whole, by a temporary file and a rename), so something else wrote it; remove ${sharedPath} and ${sharedPath}.tree and run the command again`,
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
  limits?: MaterializationLimits,
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
    ...(limits !== undefined && { limits }),
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
