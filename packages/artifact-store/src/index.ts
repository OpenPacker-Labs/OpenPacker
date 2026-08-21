import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import {
  open,
  mkdir,
  link,
  rm,
  lstat,
  writeFile,
  readFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import type {
  ArtifactDescriptor,
  ArtifactStat,
  ArtifactStore,
  ByteRange,
} from '@openpacker/artifact-model';

const MAXIMUM_BLOB_BYTES = 1024 * 1024 * 1024;
import {
  ArtifactIntegrityError,
  digestString,
  streamFromBytes,
  validateDigest,
  validateRange,
  verifyBytes,
} from '@openpacker/artifact-model';

const jsonBytes = (value: unknown): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(value));

function safeDigestName(descriptor: ArtifactDescriptor): string {
  validateDigest(descriptor.digest);
  return descriptor.digest.value;
}

export class FilesystemArtifactStore implements ArtifactStore {
  readonly implementation = {
    id: 'org.openpacker.filesystem-cas',
    version: '1',
    capabilities: ['stat', 'range', 'read', 'write', 'referrers'] as const,
    deterministic: true,
  };

  constructor(readonly root: string) {}

  async initialize(): Promise<void> {
    await Promise.all([
      mkdir(join(this.root, 'blobs', 'sha256'), { recursive: true }),
      mkdir(join(this.root, 'referrers', 'sha256'), { recursive: true }),
      mkdir(join(this.root, 'tmp'), { recursive: true }),
    ]);
  }

  private blobPath(descriptor: ArtifactDescriptor): string {
    return join(this.root, 'blobs', 'sha256', safeDigestName(descriptor));
  }

  async stat(
    descriptor: ArtifactDescriptor,
    signal?: AbortSignal,
  ): Promise<ArtifactStat> {
    signal?.throwIfAborted();
    try {
      const handle = await this.openVerifiedHandle(descriptor, signal);
      try {
        return { descriptor, rangeSupported: true };
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (error instanceof ArtifactIntegrityError) throw error;
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        throw new ArtifactIntegrityError(
          'ARTIFACT_NOT_FOUND',
          descriptor,
          `No CAS object for ${digestString(descriptor.digest)}`,
        );
      }
      throw error;
    }
  }

  async open(
    descriptor: ArtifactDescriptor,
    range?: ByteRange,
    signal?: AbortSignal,
  ): Promise<ReadableStream<Uint8Array>> {
    validateRange(range);
    const start = range?.offset ?? 0;
    if (start > descriptor.size)
      throw new RangeError('Range starts after artifact end');
    const available = descriptor.size - start;
    const length = Math.min(range?.length ?? available, available);
    const handle = await this.openVerifiedHandle(descriptor, signal);
    let position = start;
    let remaining = length;
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (signal?.aborted) {
          await handle.close();
          controller.error(
            signal.reason ??
              new DOMException('Operation aborted', 'AbortError'),
          );
          return;
        }
        if (remaining === 0) {
          await handle.close();
          controller.close();
          return;
        }
        const buffer = new Uint8Array(Math.min(64 * 1024, remaining));
        const { bytesRead } = await handle.read(
          buffer,
          0,
          buffer.byteLength,
          position,
        );
        if (bytesRead === 0) {
          await handle.close();
          controller.error(
            new ArtifactIntegrityError(
              'SIZE_MISMATCH',
              descriptor,
              'CAS object ended before its descriptor size',
            ),
          );
          return;
        }
        position += bytesRead;
        remaining -= bytesRead;
        controller.enqueue(buffer.subarray(0, bytesRead));
      },
      async cancel() {
        await handle.close();
      },
    });
  }

  private async openVerifiedHandle(
    descriptor: ArtifactDescriptor,
    signal?: AbortSignal,
  ) {
    const path = this.blobPath(descriptor);
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile())
        throw new ArtifactIntegrityError(
          'ARTIFACT_NOT_FOUND',
          descriptor,
          'CAS object is not a regular file',
        );
      if (before.size !== BigInt(descriptor.size))
        throw new ArtifactIntegrityError(
          'SIZE_MISMATCH',
          descriptor,
          `CAS object has ${before.size} bytes, expected ${descriptor.size}`,
        );
      const hash = createHash('sha256');
      const buffer = new Uint8Array(64 * 1024);
      let position = 0;
      while (position < descriptor.size) {
        signal?.throwIfAborted();
        const { bytesRead } = await handle.read(
          buffer,
          0,
          Math.min(buffer.length, descriptor.size - position),
          position,
        );
        if (bytesRead === 0) break;
        hash.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
      const [after, named] = await Promise.all([
        handle.stat({ bigint: true }),
        lstat(path, { bigint: true }),
      ]);
      if (
        position !== descriptor.size ||
        hash.digest('hex') !== descriptor.digest.value ||
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.ctimeNs !== after.ctimeNs ||
        before.mtimeNs !== after.mtimeNs ||
        after.dev !== named.dev ||
        after.ino !== named.ino
      )
        throw new ArtifactIntegrityError(
          'DIGEST_MISMATCH',
          descriptor,
          'CAS object content or identity changed during verification',
        );
      return handle;
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  }

  async putBlob(
    stream: ReadableStream<Uint8Array>,
    expected?: ArtifactDescriptor,
    signal?: AbortSignal,
  ): Promise<ArtifactDescriptor> {
    await this.initialize();
    const temporary = join(
      this.root,
      'tmp',
      `${Date.now()}-${randomBytes(12).toString('hex')}`,
    );
    const handle = await open(temporary, 'wx', 0o600);
    const reader = stream.getReader();
    const hash = createHash('sha256');
    let size = 0;
    try {
      while (true) {
        signal?.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        if (value.byteLength > MAXIMUM_BLOB_BYTES - size)
          throw new RangeError(
            `Artifact exceeded the ${MAXIMUM_BLOB_BYTES} byte store limit`,
          );
        if (expected !== undefined && value.byteLength > expected.size - size)
          throw new ArtifactIntegrityError(
            'SIZE_MISMATCH',
            expected,
            `Artifact exceeded its declared ${expected.size} bytes`,
          );
        size += value.byteLength;
        hash.update(value);
        await handle.write(value);
      }
      await handle.sync();
      await handle.close();
      const digest = {
        algorithm: 'sha256' as const,
        value: hash.digest('hex'),
      };
      const descriptor: ArtifactDescriptor = expected ?? {
        descriptorId: digestString(digest),
        digest,
        size,
        mediaType: 'application/octet-stream',
        artifactType: 'application/vnd.openpacker.blob',
        nativeRole: 'blob',
        locations: [],
        referrers: [],
        externalRefs: [],
      };
      if (expected && expected.size !== size)
        throw new ArtifactIntegrityError(
          'SIZE_MISMATCH',
          expected,
          `Expected ${expected.size} bytes, received ${size}`,
        );
      if (expected && expected.digest.value !== digest.value)
        throw new ArtifactIntegrityError(
          'DIGEST_MISMATCH',
          expected,
          `Expected ${digestString(expected.digest)}, received ${digestString(digest)}`,
        );
      const destination = this.blobPath(descriptor);
      try {
        await link(temporary, destination);
        await rm(temporary, { force: true });
      } catch (error) {
        if (
          typeof error !== 'object' ||
          error === null ||
          !('code' in error) ||
          (error.code !== 'EEXIST' && error.code !== 'ENOTEMPTY')
        )
          throw error;
        await rm(temporary, { force: true });
        await this.stat(descriptor, signal);
      }
      return descriptor;
    } catch (error) {
      await reader.cancel(error).catch(() => undefined);
      await handle.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    } finally {
      reader.releaseLock();
    }
  }

  async putManifest(
    bytes: Uint8Array,
    descriptor: ArtifactDescriptor,
    signal?: AbortSignal,
  ): Promise<ArtifactDescriptor> {
    signal?.throwIfAborted();
    await verifyBytes(descriptor, bytes);
    return this.putBlob(streamFromBytes(bytes), descriptor, signal);
  }

  async attachReferrer(
    subject: ArtifactDescriptor,
    descriptor: ArtifactDescriptor,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    await Promise.all([
      this.stat(subject, signal),
      this.stat(descriptor, signal),
    ]);
    const directory = join(
      this.root,
      'referrers',
      'sha256',
      safeDigestName(subject),
    );
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, `${safeDigestName(descriptor)}.json`),
      jsonBytes(descriptor),
      { flag: 'wx', mode: 0o600 },
    ).catch((error: unknown) => {
      if (
        typeof error !== 'object' ||
        error === null ||
        !('code' in error) ||
        error.code !== 'EEXIST'
      )
        throw error;
    });
  }

  async listReferrers(
    subject: ArtifactDescriptor,
    signal?: AbortSignal,
  ): Promise<readonly ArtifactDescriptor[]> {
    signal?.throwIfAborted();
    const directory = join(
      this.root,
      'referrers',
      'sha256',
      safeDigestName(subject),
    );
    let names: string[];
    try {
      const { readdir } = await import('node:fs/promises');
      names = (await readdir(directory))
        .filter((name) => /^[0-9a-f]{64}\.json$/u.test(name))
        .sort();
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      )
        return [];
      throw error;
    }
    const descriptors: ArtifactDescriptor[] = [];
    for (const name of names) {
      signal?.throwIfAborted();
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      const descriptor = JSON.parse(
        await readFile(join(directory, name), 'utf8'),
      ) as ArtifactDescriptor;
      const expected = name.slice(0, -'.json'.length);
      if (safeDigestName(descriptor) !== expected)
        throw new ArtifactIntegrityError(
          'DIGEST_MISMATCH',
          descriptor,
          'Referrer descriptor digest does not match its index entry',
        );
      await this.stat(descriptor, signal);
      descriptors.push(descriptor);
    }
    return descriptors;
  }
}
