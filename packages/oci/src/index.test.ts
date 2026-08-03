import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectStream, streamFromBytes } from '@openpacker/artifact-model';
import {
  OCI_EMPTY_CONFIG_BYTES,
  OciImageLayout,
  OciRegistryClient,
  ociDescriptor,
} from './index.js';

describe('OCI image layout', () => {
  it('preserves native bytes and maps subject referrers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openpacker-oci-'));
    try {
      const layout = new OciImageLayout(root);
      const native = new TextEncoder().encode(
        'exact upstream package archive bytes\n',
      );
      const packed = await layout.packNative({
        bytes: native,
        exactPurl: 'pkg:npm/%40openpacker/demo@1.0.0',
        nativeMediaType: 'application/vnd.npm.package+gzip',
        artifactType: 'application/vnd.openpacker.package',
        fileName: 'demo-1.0.0.tgz',
        reference: 'demo',
      });
      expect(
        new Uint8Array(
          await readFile(
            join(root, 'blobs', 'sha256', packed.nativeBlob.digest.slice(7)),
          ),
        ),
      ).toEqual(native);
      const receipt = new TextEncoder().encode('{"receiptVersion":"1"}');
      const referrer = await layout.attachReferrer(
        packed.manifest,
        receipt,
        'application/vnd.openpacker.prex.receipt.v1+json',
        'application/json',
      );
      expect(
        (await layout.listReferrers(packed.manifest)).map(
          ({ digest }) => digest,
        ),
      ).toEqual([referrer.digest]);
      expect((await layout.readManifest(referrer)).subject?.digest).toBe(
        packed.manifest.digest,
      );
      const manifest = await layout.readManifest(packed.manifest);
      expect(await layout.getBlob(manifest.config)).toEqual(
        OCI_EMPTY_CONFIG_BYTES,
      );
      expect(manifest.config).toMatchObject({
        digest:
          'sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
        size: 2,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a cross-origin registry upload location before forwarding credentials', async () => {
    const fetchMock: typeof fetch = async (_input, init) => {
      if (init?.method === 'HEAD') return new Response(null, { status: 404 });
      return new Response(null, {
        status: 202,
        headers: { location: 'https://attacker.invalid/upload' },
      });
    };
    const bytes = new TextEncoder().encode('blob');
    const client = new OciRegistryClient({
      registry: 'https://registry.example',
      repository: 'openpacker/demo',
      fetch: fetchMock,
    });
    await expect(
      client.pushBlob(
        await ociDescriptor(bytes, 'application/octet-stream'),
        new ReadableStream({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'UNSAFE_REDIRECT' });
  });
});

describe('OCI Distribution client', () => {
  it('retries safe reads and performs a bounded monolithic upload', async () => {
    const methods: string[] = [];
    let heads = 0;
    const bytes = new TextEncoder().encode('blob');
    const descriptor = await ociDescriptor(bytes, 'application/octet-stream');
    const fetchMock: typeof fetch = async (_input, init) => {
      const method = init?.method ?? 'GET';
      methods.push(method);
      if (method === 'HEAD') {
        heads += 1;
        return new Response(null, { status: heads === 1 ? 503 : 404 });
      }
      if (method === 'POST')
        return new Response(null, {
          status: 202,
          headers: { location: '/v2/openpacker/demo/blobs/uploads/fixture' },
        });
      if (method === 'PUT')
        return new Response(null, {
          status: 201,
          headers: { 'docker-content-digest': descriptor.digest },
        });
      return new Response(null, { status: 500 });
    };
    const client = new OciRegistryClient({
      registry: 'https://registry.example',
      repository: 'openpacker/demo',
      fetch: fetchMock,
      retryDelayMilliseconds: 0,
    });
    await client.pushBlob(descriptor, streamFromBytes(bytes));
    expect(methods).toEqual(['HEAD', 'HEAD', 'POST', 'PUT']);
  });

  it('validates Content-Range and exact streamed length', async () => {
    const bytes = new TextEncoder().encode('0123456789');
    const descriptor = await ociDescriptor(bytes, 'application/octet-stream');
    const client = new OciRegistryClient({
      registry: 'https://registry.example',
      repository: 'openpacker/demo',
      fetch: async () =>
        new Response(streamFromBytes(bytes.slice(3, 7)), {
          status: 206,
          headers: {
            'content-range': 'bytes 3-6/10',
            'content-length': '4',
          },
        }),
    });
    await expect(
      collectStream(
        await client.openBlob(descriptor, { offset: 3, length: 4 }),
      ),
    ).resolves.toEqual(bytes.slice(3, 7));
  });

  it('rejects a lying partial response', async () => {
    const bytes = new TextEncoder().encode('0123456789');
    const descriptor = await ociDescriptor(bytes, 'application/octet-stream');
    const client = new OciRegistryClient({
      registry: 'https://registry.example',
      repository: 'openpacker/demo',
      fetch: async () =>
        new Response(streamFromBytes(bytes.slice(3, 6)), {
          status: 206,
          headers: { 'content-range': 'bytes 3-6/10' },
        }),
    });
    await expect(
      collectStream(
        await client.openBlob(descriptor, { offset: 3, length: 4 }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_RANGE_RESPONSE' });
  });

  it('rejects referrer pagination loops instead of returning partial results', async () => {
    const subject = await ociDescriptor(
      new TextEncoder().encode('subject'),
      'application/octet-stream',
    );
    const client = new OciRegistryClient({
      registry: 'https://registry.example',
      repository: 'openpacker/demo',
      fetch: async () =>
        new Response(
          JSON.stringify({
            schemaVersion: 2,
            mediaType: 'application/vnd.oci.image.index.v1+json',
            manifests: [],
          }),
          {
            status: 200,
            headers: {
              link: `</v2/openpacker/demo/referrers/${encodeURIComponent(subject.digest)}>; rel="next"`,
            },
          },
        ),
    });
    await expect(client.listReferrers(subject)).rejects.toMatchObject({
      code: 'PAGINATION_LOOP',
    });
  });
});
