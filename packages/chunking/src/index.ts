import { createHash } from 'node:crypto';
import { canonicalBytes, sha256 } from '@openpacker/canonical';
import type {
  ArtifactDescriptor,
  Digest,
  JsonValue,
} from '@openpacker/contracts';

export interface ChunkingParameters {
  minimumSize: number;
  averageSize: number;
  maximumSize: number;
}

export interface ChunkRecord {
  offset: number;
  length: number;
  digest: Digest;
}

export interface ChunkIndex {
  indexVersion: '1';
  subject: { digest: Digest; size: number };
  chunking: { algorithm: 'openpacker-gear-v1'; parameters: ChunkingParameters };
  chunks: ChunkRecord[];
  merkleRoot: Digest;
  implementation: { name: '@openpacker/chunking'; version: '0.1.0' };
}

export const DEFAULT_CHUNKING_PARAMETERS: ChunkingParameters = {
  minimumSize: 64 * 1024,
  averageSize: 256 * 1024,
  maximumSize: 1024 * 1024,
};

export const MAXIMUM_CHUNK_SIZE = 64 * 1024 * 1024;
export const DEFAULT_RECONSTRUCTION_LIMIT = 512 * 1024 * 1024;

const GEAR = (() => {
  const values = new Uint32Array(256);
  let state = 0x9e3779b9;
  for (let index = 0; index < values.length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    values[index] = state >>> 0;
  }
  return values;
})();

function validateParameters(parameters: ChunkingParameters): void {
  const { minimumSize, averageSize, maximumSize } = parameters;
  if (
    ![minimumSize, averageSize, maximumSize].every(
      (value) => Number.isSafeInteger(value) && value > 0,
    )
  )
    throw new RangeError('Chunk sizes must be positive safe integers');
  if (minimumSize > averageSize || averageSize > maximumSize)
    throw new RangeError(
      'Chunk sizes must satisfy minimum <= average <= maximum',
    );
  if (maximumSize > MAXIMUM_CHUNK_SIZE)
    throw new RangeError(`maximumSize must not exceed ${MAXIMUM_CHUNK_SIZE}`);
}

const maskFor = (averageSize: number): number =>
  (2 ** Math.max(1, Math.round(Math.log2(averageSize))) - 1) >>> 0;

function merkleRoot(digests: readonly Digest[]): Digest {
  if (digests.length === 0)
    return { algorithm: 'sha256', value: createHash('sha256').digest('hex') };
  let level: Uint8Array<ArrayBufferLike>[] = digests.map(({ value }) =>
    Uint8Array.from(
      value.match(/../gu)?.map((pair) => Number.parseInt(pair, 16)) ?? [],
    ),
  );
  while (level.length > 1) {
    const next: Uint8Array<ArrayBufferLike>[] = [];
    for (let index = 0; index < level.length; index += 2) {
      const left = level[index];
      const right = level[index + 1] ?? left;
      if (!left || !right) throw new Error('Invalid Merkle level');
      const combined = new Uint8Array(left.byteLength + right.byteLength);
      combined.set(left);
      combined.set(right, left.byteLength);
      const digest = createHash('sha256').update(combined).digest('hex');
      next.push(
        Uint8Array.from(
          digest.match(/../gu)?.map((pair) => Number.parseInt(pair, 16)) ?? [],
        ),
      );
    }
    level = next;
  }
  const root = level[0];
  if (!root) throw new Error('Missing Merkle root');
  return {
    algorithm: 'sha256',
    value: [...root].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
  };
}

export async function createChunkIndex(
  stream: ReadableStream<Uint8Array>,
  subject: Pick<ArtifactDescriptor, 'digest' | 'size'>,
  parameters: ChunkingParameters = DEFAULT_CHUNKING_PARAMETERS,
  onChunk?: (chunk: Uint8Array, record: ChunkRecord) => void | Promise<void>,
  signal?: AbortSignal,
): Promise<ChunkIndex> {
  validateParameters(parameters);
  const reader = stream.getReader();
  const artifactHash = createHash('sha256');
  const buffer = new Uint8Array(parameters.maximumSize);
  const chunks: ChunkRecord[] = [];
  const mask = maskFor(parameters.averageSize);
  let offset = 0;
  let length = 0;
  let rolling = 0;

  const emit = async (): Promise<void> => {
    if (length === 0) return;
    const bytes = buffer.slice(0, length);
    const record = { offset, length, digest: await sha256(bytes) };
    chunks.push(record);
    await onChunk?.(bytes, record);
    offset += length;
    length = 0;
    rolling = 0;
  };

  try {
    while (true) {
      signal?.throwIfAborted();
      const item = await reader.read();
      if (item.done) break;
      if (!item.value) continue;
      artifactHash.update(item.value);
      for (const byte of item.value) {
        buffer[length] = byte;
        length += 1;
        rolling = ((rolling << 1) + (GEAR[byte] ?? 0)) >>> 0;
        if (
          length >= parameters.maximumSize ||
          (length >= parameters.minimumSize && (rolling & mask) === 0)
        )
          await emit();
      }
    }
    await emit();
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (offset !== subject.size)
    throw new ChunkIntegrityError(
      'SIZE_MISMATCH',
      `Chunked ${offset} bytes, expected ${subject.size}`,
    );
  const actual = artifactHash.digest('hex');
  if (actual !== subject.digest.value)
    throw new ChunkIntegrityError(
      'DIGEST_MISMATCH',
      `Chunked sha256:${actual}, expected sha256:${subject.digest.value}`,
    );
  return {
    indexVersion: '1',
    subject: { digest: subject.digest, size: subject.size },
    chunking: { algorithm: 'openpacker-gear-v1', parameters },
    chunks,
    merkleRoot: merkleRoot(chunks.map(({ digest }) => digest)),
    implementation: { name: '@openpacker/chunking', version: '0.1.0' },
  };
}

export async function reconstruct(
  index: ChunkIndex,
  fetchChunk: (
    record: ChunkRecord,
    signal?: AbortSignal,
  ) => Promise<Uint8Array>,
  signal?: AbortSignal,
  maximumBytes = DEFAULT_RECONSTRUCTION_LIMIT,
): Promise<Uint8Array> {
  validateChunkIndex(index);
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0)
    throw new RangeError('maximumBytes must be a non-negative safe integer');
  if (index.subject.size > maximumBytes)
    throw new ChunkIntegrityError(
      'SUBJECT_SIZE_LIMIT',
      `Chunk subject exceeds ${maximumBytes} bytes`,
    );
  const output = new Uint8Array(index.subject.size);
  for (const record of index.chunks) {
    signal?.throwIfAborted();
    const bytes = await fetchChunk(record, signal);
    if (bytes.byteLength !== record.length)
      throw new ChunkIntegrityError(
        'CHUNK_SIZE_MISMATCH',
        `Chunk at ${record.offset} has wrong length`,
      );
    const digest = await sha256(bytes);
    if (digest.value !== record.digest.value)
      throw new ChunkIntegrityError(
        'CHUNK_DIGEST_MISMATCH',
        `Chunk at ${record.offset} has wrong digest`,
      );
    output.set(bytes, record.offset);
  }
  const digest = await sha256(output);
  if (digest.value !== index.subject.digest.value)
    throw new ChunkIntegrityError(
      'DIGEST_MISMATCH',
      'Reconstructed artifact digest does not match subject',
    );
  return output;
}

export function validateChunkIndex(index: ChunkIndex): void {
  if (index.indexVersion !== '1')
    throw new ChunkIntegrityError(
      'INVALID_VERSION',
      'Unsupported chunk index version',
    );
  if (index.chunking.algorithm !== 'openpacker-gear-v1')
    throw new ChunkIntegrityError(
      'INVALID_ALGORITHM',
      'Unsupported content-defined chunking algorithm',
    );
  if (
    index.subject.digest.algorithm !== 'sha256' ||
    !/^[0-9a-f]{64}$/u.test(index.subject.digest.value)
  )
    throw new ChunkIntegrityError(
      'INVALID_SUBJECT_DIGEST',
      'Invalid subject digest',
    );
  if (!Number.isSafeInteger(index.subject.size) || index.subject.size < 0)
    throw new ChunkIntegrityError(
      'INVALID_SUBJECT_SIZE',
      'Invalid subject size',
    );
  if (
    index.implementation.name !== '@openpacker/chunking' ||
    !/^\d+\.\d+\.\d+$/u.test(index.implementation.version)
  )
    throw new ChunkIntegrityError(
      'INVALID_IMPLEMENTATION',
      'Invalid chunker implementation identity',
    );
  validateParameters(index.chunking.parameters);
  let offset = 0;
  for (const [position, chunk] of index.chunks.entries()) {
    if (chunk.offset !== offset)
      throw new ChunkIntegrityError(
        'INVALID_OFFSET',
        `Expected offset ${offset}, received ${chunk.offset}`,
      );
    if (
      position < index.chunks.length - 1 &&
      chunk.length < index.chunking.parameters.minimumSize
    )
      throw new ChunkIntegrityError(
        'INVALID_LENGTH',
        `Non-final chunk at ${chunk.offset} is below the minimum size`,
      );
    if (
      !Number.isSafeInteger(chunk.length) ||
      chunk.length <= 0 ||
      chunk.length > index.chunking.parameters.maximumSize
    )
      throw new ChunkIntegrityError(
        'INVALID_LENGTH',
        `Invalid chunk length at ${chunk.offset}`,
      );
    if (
      !/^[0-9a-f]{64}$/u.test(chunk.digest.value) ||
      chunk.digest.algorithm !== 'sha256'
    )
      throw new ChunkIntegrityError(
        'INVALID_DIGEST',
        `Invalid chunk digest at ${chunk.offset}`,
      );
    offset += chunk.length;
  }
  if (offset !== index.subject.size)
    throw new ChunkIntegrityError(
      'SIZE_MISMATCH',
      `Chunk index covers ${offset} bytes, expected ${index.subject.size}`,
    );
  if (
    index.merkleRoot.algorithm !== 'sha256' ||
    !/^[0-9a-f]{64}$/u.test(index.merkleRoot.value)
  )
    throw new ChunkIntegrityError('INVALID_MERKLE_ROOT', 'Invalid Merkle root');
  const expectedRoot = merkleRoot(index.chunks.map(({ digest }) => digest));
  if (expectedRoot.value !== index.merkleRoot.value)
    throw new ChunkIntegrityError(
      'MERKLE_ROOT_MISMATCH',
      'Chunk-index Merkle root does not match ordered chunk digests',
    );
}

export function chunkIndexBytes(index: ChunkIndex): Uint8Array {
  validateChunkIndex(index);
  return canonicalBytes(index as unknown as JsonValue);
}

export class ChunkIntegrityError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ChunkIntegrityError';
  }
}
