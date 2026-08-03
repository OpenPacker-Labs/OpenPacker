import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  collectStream,
  descriptorForBytes,
  streamFromBytes,
} from '@openpacker/artifact-model';
import { FilesystemArtifactStore } from './index.js';

describe('filesystem artifact store', () => {
  it('streams immutable bytes, ranges, and referrers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openpacker-cas-'));
    try {
      const store = new FilesystemArtifactStore(root);
      const bytes = new TextEncoder().encode('0123456789');
      const descriptor = await descriptorForBytes({
        bytes,
        descriptorId: 'native',
        mediaType: 'application/octet-stream',
        artifactType: 'application/vnd.openpacker.package',
        nativeRole: 'package',
      });
      await store.putBlob(streamFromBytes(bytes), descriptor);
      expect(
        await collectStream(
          await store.open(descriptor, { offset: 3, length: 4 }),
        ),
      ).toEqual(new TextEncoder().encode('3456'));
      const referrerBytes = new TextEncoder().encode('receipt');
      const referrer = await descriptorForBytes({
        bytes: referrerBytes,
        descriptorId: 'receipt',
        mediaType: 'application/json',
        artifactType: 'application/vnd.openpacker.receipt',
        nativeRole: 'evidence',
      });
      await store.putBlob(streamFromBytes(referrerBytes), referrer);
      await store.attachReferrer(descriptor, referrer);
      expect(
        (await store.listReferrers(descriptor)).map(
          ({ descriptorId }) => descriptorId,
        ),
      ).toEqual(['receipt']);
      expect(
        await readFile(join(root, 'blobs', 'sha256', descriptor.digest.value)),
      ).toEqual(Buffer.from(bytes));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails closed on a digest mismatch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openpacker-cas-'));
    try {
      const store = new FilesystemArtifactStore(root);
      const expectedBytes = new TextEncoder().encode('expected');
      const descriptor = await descriptorForBytes({
        bytes: expectedBytes,
        descriptorId: 'native',
        mediaType: 'application/octet-stream',
        artifactType: 'application/vnd.openpacker.package',
        nativeRole: 'package',
      });
      await expect(
        store.putBlob(
          streamFromBytes(new TextEncoder().encode('tampered')),
          descriptor,
        ),
      ).rejects.toMatchObject({ code: 'DIGEST_MISMATCH' });
      await store.putBlob(streamFromBytes(expectedBytes), descriptor);
      await writeFile(
        join(root, 'blobs', 'sha256', descriptor.digest.value),
        new TextEncoder().encode('tampered'),
      );
      await expect(store.stat(descriptor)).rejects.toMatchObject({
        code: 'DIGEST_MISMATCH',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
