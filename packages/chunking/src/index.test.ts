import { describe, expect, it } from 'vitest';
import {
  descriptorForBytes,
  streamFromBytes,
} from '@openpacker/artifact-model';
import {
  chunkIndexBytes,
  createChunkIndex,
  reconstruct,
  validateChunkIndex,
} from './index.js';

describe('content-defined chunking', () => {
  it('splits deterministically and reconstructs exact subject bytes', async () => {
    const bytes = new TextEncoder().encode(
      'alpha-alpha-alpha-beta-beta-gamma-gamma-delta',
    );
    const subject = await descriptorForBytes({
      bytes,
      descriptorId: 'subject',
      mediaType: 'application/octet-stream',
      artifactType: 'package',
      nativeRole: 'package',
    });
    const chunks = new Map<string, Uint8Array>();
    const index = await createChunkIndex(
      streamFromBytes(bytes),
      subject,
      { minimumSize: 4, averageSize: 8, maximumSize: 16 },
      (chunk, record) => {
        chunks.set(record.digest.value, chunk);
      },
    );
    const second = await createChunkIndex(streamFromBytes(bytes), subject, {
      minimumSize: 4,
      averageSize: 8,
      maximumSize: 16,
    });
    expect(chunkIndexBytes(second)).toEqual(chunkIndexBytes(index));
    await expect(
      reconstruct(
        index,
        async (record) => chunks.get(record.digest.value) ?? new Uint8Array(),
      ),
    ).resolves.toEqual(bytes);
  });

  it('rejects tampered chunks', async () => {
    const bytes = new TextEncoder().encode('0123456789abcdef');
    const subject = await descriptorForBytes({
      bytes,
      descriptorId: 'subject',
      mediaType: 'application/octet-stream',
      artifactType: 'package',
      nativeRole: 'package',
    });
    const index = await createChunkIndex(streamFromBytes(bytes), subject, {
      minimumSize: 4,
      averageSize: 8,
      maximumSize: 8,
    });
    await expect(
      reconstruct(index, async (record) => new Uint8Array(record.length)),
    ).rejects.toMatchObject({ code: 'CHUNK_DIGEST_MISMATCH' });
  });

  it('validates the complete index envelope and Merkle root', async () => {
    const bytes = new TextEncoder().encode('complete-index-validation');
    const subject = await descriptorForBytes({
      bytes,
      descriptorId: 'subject',
      mediaType: 'application/octet-stream',
      artifactType: 'package',
      nativeRole: 'package',
    });
    const index = await createChunkIndex(streamFromBytes(bytes), subject, {
      minimumSize: 4,
      averageSize: 8,
      maximumSize: 16,
    });
    expect(() => validateChunkIndex(index)).not.toThrow();
    const merkle = structuredClone(index);
    merkle.merkleRoot.value = '0'.repeat(64);
    expect(() => validateChunkIndex(merkle)).toThrowError(
      expect.objectContaining({ code: 'MERKLE_ROOT_MISMATCH' }),
    );
    const algorithm = structuredClone(index) as unknown as {
      chunking: { algorithm: string };
    };
    algorithm.chunking.algorithm = 'unknown';
    expect(() => validateChunkIndex(algorithm as never)).toThrowError(
      expect.objectContaining({ code: 'INVALID_ALGORITHM' }),
    );
  });

  it('rejects oversized reconstruction before allocating output', async () => {
    const bytes = new Uint8Array([1]);
    const subject = await descriptorForBytes({
      bytes,
      descriptorId: 'bounded',
      mediaType: 'application/octet-stream',
      artifactType: 'package',
      nativeRole: 'package',
    });
    const index = await createChunkIndex(streamFromBytes(bytes), subject, {
      minimumSize: 1,
      averageSize: 1,
      maximumSize: 1,
    });
    index.subject.size = 1024;
    index.chunks[0]!.length = 1024;
    index.chunking.parameters.maximumSize = 1024;
    await expect(
      reconstruct(index, async () => bytes, undefined, 16),
    ).rejects.toMatchObject({ code: 'SUBJECT_SIZE_LIMIT' });
  });
});
