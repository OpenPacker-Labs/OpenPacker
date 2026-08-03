import { formatDigest, sha256 } from '@openpacker/canonical';
import type {
  ArtifactDescriptor,
  Digest,
  ExternalRef,
} from '@openpacker/contracts';

export type {
  ArtifactDescriptor,
  ArtifactLocation,
  Digest,
  ExternalRef,
} from '@openpacker/contracts';

export const ARTIFACT_MEDIA_TYPES = {
  npm: 'application/vnd.npm.package+gzip',
  cargo: 'application/vnd.crates.io.crate+gzip',
  nuget: 'application/vnd.nuget.package+zip',
  metadata: 'application/vnd.openpacker.package.metadata.v1+json',
  receipt: 'application/vnd.openpacker.prex.receipt.v1+json',
  overlay: 'application/vnd.openpacker.overlay.v1+json',
  chunkIndex: 'application/vnd.openpacker.chunk-index.v1+json',
} as const;

export interface ByteRange {
  offset: number;
  length?: number;
}

export interface ArtifactStat {
  descriptor: ArtifactDescriptor;
  rangeSupported: boolean;
}

export interface ArtifactSource {
  stat(
    descriptor: ArtifactDescriptor,
    signal?: AbortSignal,
  ): Promise<ArtifactStat>;
  open(
    descriptor: ArtifactDescriptor,
    range?: ByteRange,
    signal?: AbortSignal,
  ): Promise<ReadableStream<Uint8Array>>;
  listReferrers(
    subject: ArtifactDescriptor,
    signal?: AbortSignal,
  ): Promise<readonly ArtifactDescriptor[]>;
}

export interface ArtifactSink {
  putBlob(
    stream: ReadableStream<Uint8Array>,
    expected?: ArtifactDescriptor,
    signal?: AbortSignal,
  ): Promise<ArtifactDescriptor>;
  putManifest(
    bytes: Uint8Array,
    descriptor: ArtifactDescriptor,
    signal?: AbortSignal,
  ): Promise<ArtifactDescriptor>;
  attachReferrer(
    subject: ArtifactDescriptor,
    descriptor: ArtifactDescriptor,
    signal?: AbortSignal,
  ): Promise<void>;
}

export interface ArtifactStore extends ArtifactSource, ArtifactSink {}

export interface ArtifactImplementationInfo {
  id: string;
  version: string;
  capabilities: readonly ('stat' | 'range' | 'read' | 'write' | 'referrers')[];
  deterministic: boolean;
}

const abortError = (signal?: AbortSignal): unknown =>
  signal?.reason ?? new DOMException('Operation aborted', 'AbortError');

export function digestString(digest: Digest): string {
  return formatDigest(digest);
}

export function validateDigest(digest: Digest): void {
  formatDigest(digest);
}

export function validateRange(range?: ByteRange): void {
  if (!range) return;
  if (!Number.isSafeInteger(range.offset) || range.offset < 0)
    throw new RangeError('Range offset must be a non-negative safe integer');
  if (
    range.length !== undefined &&
    (!Number.isSafeInteger(range.length) || range.length <= 0)
  ) {
    throw new RangeError('Range length must be a positive safe integer');
  }
}

export function streamFromBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

export async function collectStream(
  stream: ReadableStream<Uint8Array>,
  maximumBytes = Number.MAX_SAFE_INTEGER,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0)
    throw new RangeError('maximumBytes must be a non-negative safe integer');
  const reader = stream.getReader();
  const onAbort = () => void reader.cancel(abortError(signal));
  const chunks: Uint8Array[] = [];
  let size = 0;
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    while (true) {
      if (signal?.aborted) throw abortError(signal);
      const { done, value } = await reader.read();
      if (signal?.aborted) throw abortError(signal);
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > maximumBytes)
        throw new RangeError(`Stream exceeds ${maximumBytes} bytes`);
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export async function descriptorForBytes(input: {
  bytes: Uint8Array;
  descriptorId: string;
  mediaType: string;
  artifactType: string;
  nativeRole: string;
  fileName?: string;
  referrers?: ExternalRef[];
}): Promise<ArtifactDescriptor> {
  const base: ArtifactDescriptor = {
    descriptorId: input.descriptorId,
    digest: await sha256(input.bytes),
    size: input.bytes.byteLength,
    mediaType: input.mediaType,
    artifactType: input.artifactType,
    nativeRole: input.nativeRole,
    locations: [],
    referrers: input.referrers ?? [],
    externalRefs: [],
  };
  return input.fileName === undefined
    ? base
    : { ...base, fileName: input.fileName };
}

export async function verifyBytes(
  descriptor: ArtifactDescriptor,
  bytes: Uint8Array,
): Promise<void> {
  validateDigest(descriptor.digest);
  if (bytes.byteLength !== descriptor.size)
    throw new ArtifactIntegrityError(
      'SIZE_MISMATCH',
      descriptor,
      `Expected ${descriptor.size} bytes, received ${bytes.byteLength}`,
    );
  const actual = await sha256(bytes);
  if (actual.value !== descriptor.digest.value) {
    throw new ArtifactIntegrityError(
      'DIGEST_MISMATCH',
      descriptor,
      `Expected ${digestString(descriptor.digest)}, received ${digestString(actual)}`,
    );
  }
}

export class ArtifactIntegrityError extends Error {
  constructor(
    readonly code: 'DIGEST_MISMATCH' | 'SIZE_MISMATCH' | 'ARTIFACT_NOT_FOUND',
    readonly descriptor: ArtifactDescriptor,
    message: string,
  ) {
    super(message);
    this.name = 'ArtifactIntegrityError';
  }
}
