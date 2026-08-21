import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  readdir,
  rename,
  rm,
  unlink,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  descriptorForBytes,
  streamFromBytes,
  type ArtifactSource,
} from '@openpacker/artifact-model';
import { materialize, type ArchiveFormat } from '@openpacker/materializer';
import { stableStoreTreeDigest } from './generations.js';
import { OpmError } from './types.js';
import {
  assertDigest,
  assertSafeSegment,
  ensureStableDirectory,
  openStableDirectory,
  readDirChildWithTypes,
  readStableFile,
  sharedStoreHome,
  storeKeyFromDigest,
  writeStableFile,
} from './paths.js';

export function sharedStoreRoot(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return sharedStoreHome(env);
}

export async function materializeThroughSharedStore(input: {
  digest: string;
  projectStorePath: string;
  bytes: Uint8Array | (() => Promise<Uint8Array>);
  format: ArchiveFormat;
  env?: NodeJS.ProcessEnv;
  linkFile?: (existingPath: string, newPath: string) => Promise<void>;
}): Promise<{ path: string; shared: boolean }> {
  const digest = assertDigest(input.digest);
  const projectStorePath = input.projectStorePath;
  const format = input.format;
  const linkFile = input.linkFile ?? hardlinkFile;
  const sharedRoot = sharedStoreRoot(input.env);
  if (sharedRoot === undefined) {
    const bytes = await resolveBytes(input.bytes, digest);
    await materializeArchive(bytes, format, digest, projectStorePath);
    return { path: projectStorePath, shared: false };
  }

  await ensureStableDirectory(sharedRoot);
  const sharedPath = await publishSharedEntry({
    sharedRoot,
    digest,
    format,
    bytes: input.bytes,
  });
  try {
    await linkTree(sharedPath, projectStorePath, linkFile);
    const sharedDigest = await stableStoreTreeDigest(sharedPath);
    const projectDigest = await stableStoreTreeDigest(projectStorePath);
    if (projectDigest !== sharedDigest)
      throw new OpmError(
        'VERIFICATION_FAILED',
        `Project store tree for ${digest} does not match the shared entry`,
      );
  } catch (error) {
    await rm(projectStorePath, { recursive: true, force: true }).catch(
      () => undefined,
    );
    throw error;
  }
  return { path: projectStorePath, shared: true };
}

/**
 * Break hardlinks in a project store tree so later writes (lifecycle scripts)
 * cannot mutate the shared CAS inodes they were linked from.
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
      assertSafeSegment(entry.name, 'store entry');
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
        await chmod(tmp, info.mode & 0o777);
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

async function publishSharedEntry(input: {
  sharedRoot: string;
  digest: string;
  format: ArchiveFormat;
  bytes: Uint8Array | (() => Promise<Uint8Array>);
}): Promise<string> {
  const storeKey = storeKeyFromDigest(input.digest);
  const sharedPath = join(input.sharedRoot, storeKey);
  const existing = await lstat(sharedPath).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    },
  );
  if (existing !== undefined) {
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
        `Shared store tree for ${input.digest} does not match its recorded digest`,
      );
    return sharedPath;
  }

  const bytes = await resolveBytes(input.bytes, input.digest);
  const tmp = join(
    input.sharedRoot,
    `.${storeKey}.materialize-${randomUUID()}`,
  );
  try {
    await materializeArchive(bytes, input.format, input.digest, tmp);
    const treeDigest = await stableStoreTreeDigest(tmp);
    await writeStableFile(`${sharedPath}.tree`, `${treeDigest}\n`);
    await rename(tmp, sharedPath);
    await writeStableFile(`${sharedPath}.artifact`, bytes, 0o444);
  } catch (error) {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  return sharedPath;
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
      assertSafeSegment(entry.name, 'store entry');
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
    await chmod(to, mode & 0o777);
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
      assertSafeSegment(entry.name, 'store entry');
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
