import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { ProviderError, type PackArtifact } from '@openpacker/adapter-core';
import { compareCanonicalStrings } from '@openpacker/canonical';
import type { DelegatedPackHostPlan } from '@openpacker/contracts';
import {
  lstatChild,
  openChild,
  readDirChildBounded,
  type BoundedListing,
} from '@openpacker/project-io';

/**
 * What a collection asks of the output directory. Every read names a child of
 * the directory handle the host retained, never a path: joining a name onto
 * `/proc/self/fd/N` works on Linux only, and `/dev/fd/N/<name>` names nothing
 * on macOS (ADR 0045). The default is project-io's, which uses the call each
 * platform has for "a child of this open directory"; the type is the seam
 * tests use to land a swap between two reads.
 */
export interface CollectionReads {
  list(directory: FileHandle, limit: number): Promise<BoundedListing>;
  lstat(directory: FileHandle, name: string): Promise<BigIntStats>;
  open(directory: FileHandle, name: string): Promise<FileHandle>;
}

export const handleRelativeReads: CollectionReads = {
  list: readDirChildBounded,
  lstat: lstatChild,
  open: (directory, name) =>
    openChild(directory, name, constants.O_RDONLY | constants.O_NOFOLLOW),
};

export interface CollectionLimits {
  outputEntries: number;
  artifacts: number;
  artifactBytes: bigint;
  totalArtifactBytes: bigint;
  readChunkBytes: number;
}

const invalid = (message: string): ProviderError =>
  new ProviderError('INVALID_RESPONSE', message);

/**
 * The declared artifacts a provider left in its output directory, hashed.
 *
 * `directory` is the retained handle of that directory. The listing is bounded
 * while it is read, each artifact is opened with a no-follow child open (a
 * symlink in the last component is refused, not followed), and each is
 * checked against the directory entry it came from before and after its bytes
 * were read, so a file replaced or grown mid-read is an error, not a digest.
 */
export async function collectArtifacts(
  directory: FileHandle,
  reportedDirectory: string,
  plan: DelegatedPackHostPlan,
  limits: CollectionLimits,
  reads: CollectionReads = handleRelativeReads,
): Promise<PackArtifact[]> {
  const artifacts: PackArtifact[] = [];
  let totalBytes = 0n;
  const listing = await reads.list(directory, limits.outputEntries);
  if (listing.exceeded)
    throw invalid(
      `Delegated provider output exceeds ${limits.outputEntries} entries`,
    );
  const entries = [...listing.entries].sort((left, right) =>
    compareCanonicalStrings(left.name, right.name),
  );
  const chunk = Buffer.allocUnsafe(Math.max(1, limits.readChunkBytes));
  for (const entry of entries) {
    if (entry.name === 'opm-pack-receipt.json')
      throw invalid('Delegated providers may not create the host receipt');
    if (!entry.isFile()) continue;
    const type = plan.artifacts.find(
      (candidate) =>
        ('basename' in candidate && candidate.basename === entry.name) ||
        ('suffix' in candidate && entry.name.endsWith(candidate.suffix)),
    );
    if (type === undefined) continue;
    if (artifacts.length >= limits.artifacts)
      throw invalid(
        `Delegated provider output exceeds ${limits.artifacts} artifacts`,
      );
    const before = await reads.lstat(directory, entry.name);
    if (!before.isFile() || before.isSymbolicLink())
      throw invalid(`Artifact is not a regular file: ${entry.name}`);
    if (before.size > limits.artifactBytes)
      throw invalid(
        `Artifact exceeds ${limits.artifactBytes} bytes: ${entry.name}`,
      );
    const handle = await reads.open(directory, entry.name);
    try {
      const opened = await handle.stat({ bigint: true });
      if (opened.dev !== before.dev || opened.ino !== before.ino)
        throw invalid(`Artifact changed while opening: ${entry.name}`);
      const hash = createHash('sha256');
      let bytes = 0n;
      for (;;) {
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
        if (bytesRead === 0) break;
        bytes += BigInt(bytesRead);
        if (bytes > limits.artifactBytes)
          throw invalid(
            `Artifact exceeds ${limits.artifactBytes} bytes while hashing: ${entry.name}`,
          );
        hash.update(chunk.subarray(0, bytesRead));
      }
      const [after, named] = await Promise.all([
        handle.stat({ bigint: true }),
        reads.lstat(directory, entry.name),
      ]);
      if (
        opened.size !== after.size ||
        opened.mtimeNs !== after.mtimeNs ||
        opened.ctimeNs !== after.ctimeNs ||
        bytes !== after.size ||
        after.dev !== named.dev ||
        after.ino !== named.ino
      )
        throw invalid(`Artifact changed while hashing: ${entry.name}`);
      totalBytes += after.size;
      if (totalBytes > limits.totalArtifactBytes)
        throw invalid(
          `Delegated provider artifacts exceed ${limits.totalArtifactBytes} total bytes`,
        );
      artifacts.push({
        path: join(reportedDirectory, entry.name),
        mediaType: type.mediaType,
        size: Number(after.size),
        digest: `sha256:${hash.digest('hex')}`,
        nativeRole: type.nativeRole,
        outputName: entry.name,
      });
    } finally {
      await handle.close();
    }
  }
  return artifacts;
}
