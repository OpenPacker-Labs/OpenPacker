import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectStream, streamFromBytes } from '@openpacker/artifact-model';
import {
  BearerTokenAuthentication,
  OCI_EMPTY_CONFIG_BYTES,
  OCI_MEDIA_TYPES,
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
  it('rejects plaintext registry origins', () => {
    expect(
      () =>
        new OciRegistryClient({
          registry: 'http://registry.example',
          repository: 'openpacker/demo',
        }),
    ).toThrow(/must use HTTPS/u);
  });

  it('bounds registry error bodies before decoding diagnostics', async () => {
    const client = new OciRegistryClient({
      registry: 'https://registry.example',
      repository: 'openpacker/demo',
      maximumAttempts: 1,
      fetch: (async () =>
        new Response('x'.repeat(70 * 1024), {
          status: 500,
        })) as unknown as typeof fetch,
    });
    await expect(client.pullManifest('latest')).rejects.toMatchObject({
      code: 'REGISTRY_ERROR',
      message: expect.stringContaining('oversized error body'),
    });
  });

  it('bounds time spent reading a stalled registry error body', async () => {
    const client = new OciRegistryClient({
      registry: 'https://registry.example',
      repository: 'openpacker/demo',
      maximumAttempts: 1,
      errorBodyTimeoutMilliseconds: 5,
      fetch: (async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull: () => new Promise(() => undefined),
          }),
          { status: 500 },
        )) as unknown as typeof fetch,
    });
    await expect(client.pullManifest('latest')).rejects.toMatchObject({
      code: 'REGISTRY_ERROR',
      message: expect.stringContaining('read deadline'),
    });
  });

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

  it('fetches and verifies referrer subject and artifact type bindings', async () => {
    const subject = await ociDescriptor(
      new TextEncoder().encode('subject'),
      'application/vnd.test.subject',
    );
    const artifactType = 'application/vnd.test.attestation';
    const manifestBytes = new TextEncoder().encode(
      JSON.stringify({
        schemaVersion: 2,
        mediaType: OCI_MEDIA_TYPES.manifest,
        artifactType,
        config: await ociDescriptor(
          OCI_EMPTY_CONFIG_BYTES,
          OCI_MEDIA_TYPES.emptyConfig,
        ),
        layers: [],
        subject,
      }),
    );
    const referrer = await ociDescriptor(
      manifestBytes,
      OCI_MEDIA_TYPES.manifest,
      { artifactType },
    );
    const client = new OciRegistryClient({
      registry: 'https://registry.example',
      repository: 'openpacker/demo',
      fetch: async (input) =>
        String(input).includes('/referrers/')
          ? new Response(
              JSON.stringify({
                schemaVersion: 2,
                mediaType: OCI_MEDIA_TYPES.index,
                manifests: [referrer],
              }),
              { status: 200 },
            )
          : new Response(manifestBytes, {
              status: 200,
              headers: { 'content-type': OCI_MEDIA_TYPES.manifest },
            }),
    });
    await expect(client.listReferrers(subject, artifactType)).resolves.toEqual([
      referrer,
    ]);
  });

  it.each(['subject', 'artifact type', 'index descriptor'] as const)(
    'rejects a referrer with a mismatched %s binding',
    async (mismatch) => {
      const subject = await ociDescriptor(
        new TextEncoder().encode('subject'),
        'application/vnd.test.subject',
      );
      const wrongSubject = await ociDescriptor(
        new TextEncoder().encode('other'),
        'application/vnd.test.subject',
      );
      const artifactType = 'application/vnd.test.attestation';
      const manifestBytes = new TextEncoder().encode(
        JSON.stringify({
          schemaVersion: 2,
          mediaType: OCI_MEDIA_TYPES.manifest,
          artifactType:
            mismatch === 'artifact type'
              ? 'application/vnd.test.other'
              : artifactType,
          config: await ociDescriptor(
            OCI_EMPTY_CONFIG_BYTES,
            OCI_MEDIA_TYPES.emptyConfig,
          ),
          layers: [],
          subject: mismatch === 'subject' ? wrongSubject : subject,
        }),
      );
      const referrer = await ociDescriptor(
        manifestBytes,
        OCI_MEDIA_TYPES.manifest,
        { artifactType },
      );
      const indexed =
        mismatch === 'index descriptor'
          ? { ...referrer, size: referrer.size + 1 }
          : referrer;
      const client = new OciRegistryClient({
        registry: 'https://registry.example',
        repository: 'openpacker/demo',
        fetch: async (input) =>
          String(input).includes('/referrers/')
            ? new Response(
                JSON.stringify({
                  schemaVersion: 2,
                  mediaType: OCI_MEDIA_TYPES.index,
                  manifests: [indexed],
                }),
                { status: 200 },
              )
            : new Response(manifestBytes, {
                status: 200,
                headers: { 'content-type': OCI_MEDIA_TYPES.manifest },
              }),
      });
      await expect(
        client.listReferrers(subject, artifactType),
      ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    },
  );

  it('rejects oversized referrer manifests before fetching them', async () => {
    const subject = await ociDescriptor(
      new TextEncoder().encode('subject'),
      'application/vnd.test.subject',
    );
    let requests = 0;
    const client = new OciRegistryClient({
      registry: 'https://registry.example',
      repository: 'openpacker/demo',
      fetch: async () => {
        requests += 1;
        return new Response(
          JSON.stringify({
            schemaVersion: 2,
            mediaType: OCI_MEDIA_TYPES.index,
            manifests: [
              {
                digest: `sha256:${'a'.repeat(64)}`,
                mediaType: OCI_MEDIA_TYPES.manifest,
                size: 1024 * 1024 + 1,
              },
            ],
          }),
          { status: 200 },
        );
      },
    });
    await expect(client.listReferrers(subject)).rejects.toMatchObject({
      code: 'PAGINATION_LIMIT',
    });
    expect(requests).toBe(1);
  });
});

describe('tag listing and bearer authentication', () => {
  const jsonResponse = (body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json', ...headers },
    });

  it('follows Link pagination and stops at the last page', async () => {
    const calls: string[] = [];
    const fetchImplementation = (async (url: URL | string) => {
      const href = String(url);
      calls.push(href);
      if (href.endsWith('/tags/list'))
        return jsonResponse(
          { tags: ['1.0', '1.1'] },
          { link: '</v2/demo/tags/list?last=1.1>; rel="next"' },
        );
      return jsonResponse({ tags: ['2.0'] });
    }) as unknown as typeof fetch;

    const client = new OciRegistryClient({
      registry: 'https://registry.test',
      repository: 'demo',
      fetch: fetchImplementation,
    });
    expect(await client.listTags()).toEqual(['1.0', '1.1', '2.0']);
    expect(calls).toHaveLength(2);
  });

  it('refuses pagination that points at another origin', async () => {
    const fetchImplementation = (async () =>
      jsonResponse(
        { tags: ['1.0'] },
        { link: '<https://evil.example/v2/demo/tags/list>; rel="next"' },
      )) as unknown as typeof fetch;
    const client = new OciRegistryClient({
      registry: 'https://registry.test',
      repository: 'demo',
      fetch: fetchImplementation,
    });
    await expect(client.listTags()).rejects.toMatchObject({
      code: 'UNSAFE_REDIRECT',
    });
  });

  it('rejects a registry that repeats a pagination page', async () => {
    const fetchImplementation = (async () =>
      jsonResponse(
        { tags: ['1.0'] },
        { link: '</v2/demo/tags/list>; rel="next"' },
      )) as unknown as typeof fetch;
    const client = new OciRegistryClient({
      registry: 'https://registry.test',
      repository: 'demo',
      fetch: fetchImplementation,
    });
    await expect(client.listTags()).rejects.toMatchObject({
      code: 'PAGINATION_LOOP',
    });
  });

  it('bounds tag pages, tags, response bytes, and cursor length', async () => {
    const cases = [
      {
        limits: { maximumPages: 1 },
        body: { tags: ['1.0'] },
        link: '</v2/demo/tags/list?last=1.0>; rel="next"',
      },
      { limits: { maximumTags: 1 }, body: { tags: ['1.0', '2.0'] } },
      { limits: { maximumBytes: 8 }, body: { tags: ['1.0'] } },
      {
        limits: { maximumCursorLength: 4 },
        body: { tags: ['1.0'] },
        link: '</v2/demo/tags/list?last=abcdef>; rel="next"',
      },
    ] as const;
    for (const item of cases) {
      const client = new OciRegistryClient({
        registry: 'https://registry.test',
        repository: 'demo',
        tagLimits: item.limits,
        fetch: async () =>
          jsonResponse(
            item.body,
            'link' in item && item.link ? { link: item.link } : {},
          ),
      });
      await expect(client.listTags()).rejects.toBeTruthy();
    }
  });

  it('rejects invalid tags and aborts a stalled listing at the deadline', async () => {
    const invalid = new OciRegistryClient({
      registry: 'https://registry.test',
      repository: 'demo',
      fetch: async () => jsonResponse({ tags: ['-invalid'] }),
    });
    await expect(invalid.listTags()).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });

    const stalled = new OciRegistryClient({
      registry: 'https://registry.test',
      repository: 'demo',
      tagLimits: { maximumElapsedMilliseconds: 10 },
      fetch: async (_input, init) =>
        await new Promise<Response>((_resolve, reject) =>
          init?.signal?.addEventListener('abort', () =>
            reject(init.signal!.reason),
          ),
        ),
    });
    await expect(stalled.listTags()).rejects.toMatchObject({
      code: 'PAGINATION_LIMIT',
    });
  });

  it('cancels a registry body that exceeds the mandatory idle deadline', async () => {
    let cancelled = false;
    const client = new OciRegistryClient({
      registry: 'https://registry.test',
      repository: 'demo',
      responseIdleTimeoutMilliseconds: 5,
      fetch: async () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
        ),
    });
    await expect(client.listTags()).rejects.toMatchObject({
      name: 'TimeoutError',
    });
    expect(cancelled).toBe(true);
  });

  it('applies a mandatory deadline to direct authentication requests', async () => {
    const authentication = new BearerTokenAuthentication({
      requestTimeoutMilliseconds: 5,
      fetch: async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          const abort = () => reject(init?.signal?.reason);
          init?.signal?.addEventListener('abort', abort, { once: true });
          if (init?.signal?.aborted) abort();
        }),
    });
    await expect(
      authentication.headers(
        new URL('https://registry.test/v2/demo/tags/list'),
        'repository:demo:pull',
      ),
    ).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('performs the anonymous bearer handshake and caches the token', async () => {
    let tokenRequests = 0;
    const fetchImplementation = (async (
      url: URL | string,
      init?: RequestInit,
    ) => {
      const href = String(url);
      if (href.startsWith('https://auth.test/token')) {
        tokenRequests += 1;
        expect(new URL(href).searchParams.get('scope')).toBe(
          'repository:demo:pull',
        );
        return jsonResponse({ token: 'issued', expires_in: 300 });
      }
      const authorization = new Headers(init?.headers).get('authorization');
      if (authorization !== 'Bearer issued')
        return new Response('', {
          status: 401,
          headers: {
            'www-authenticate':
              'Bearer realm="https://auth.test/token",service="registry.test",scope="repository:demo:pull"',
          },
        });
      return jsonResponse({ tags: ['1.0'] });
    }) as unknown as typeof fetch;

    const client = new OciRegistryClient({
      registry: 'https://registry.test',
      repository: 'demo',
      fetch: fetchImplementation,
      authentication: new BearerTokenAuthentication({
        fetch: fetchImplementation,
        allowedTokenOrigins: ['https://auth.test'],
      }),
    });
    expect(await client.listTags()).toEqual(['1.0']);
    expect(await client.listTags()).toEqual(['1.0']);
    // Second listing reuses the cached token rather than re-authenticating.
    expect(tokenRequests).toBe(1);
  });

  it('rejects a registry challenge that widens the requested token scope', async () => {
    const contacted: string[] = [];
    const auth = new BearerTokenAuthentication({
      fetch: (async (url: URL | string) => {
        contacted.push(String(url));
        return new Response('', {
          status: 401,
          headers: {
            'www-authenticate':
              'Bearer realm="https://registry.test/token",scope="repository:other:pull,push"',
          },
        });
      }) as unknown as typeof fetch,
    });
    await expect(
      auth.headers(
        new URL('https://registry.test/v2/demo/manifests/latest'),
        'repository:demo:pull',
      ),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(contacted).toEqual([
      'https://registry.test/v2/demo/manifests/latest',
    ]);
  });
});

describe('credentials are not handed to a server-nominated endpoint', () => {
  it('requires credentials to be bound to an exact registry origin', () => {
    expect(
      () =>
        new BearerTokenAuthentication({
          credentials: { username: 'alice', password: 'hunter2' },
        }),
    ).toThrow(/registryOrigin/u);
    expect(
      () =>
        new BearerTokenAuthentication({
          credentials: { username: 'alice', password: 'hunter2' },
          registryOrigin: 'https://registry.test/path',
        }),
    ).toThrow(/exact HTTPS origin/u);
  });

  const challenge = (realm: string) =>
    new Response('', {
      status: 401,
      headers: {
        'www-authenticate': `Bearer realm="${realm}",service="registry.test"`,
      },
    });

  it('refuses to send credentials to a token host the registry named for itself', async () => {
    // The realm arrives in the registry's own response. A hostile,
    // compromised or typo-squatted registry that answers every request with
    // realm="https://attacker/token" would otherwise be handed the user's
    // password in decodable form, and its reply trusted as a token.
    const contacted: string[] = [];
    const fetchImplementation = (async (
      url: URL | string,
      init?: RequestInit,
    ) => {
      const href = String(url);
      if (href.startsWith('https://evil.example/')) {
        contacted.push(new Headers(init?.headers).get('authorization') ?? '');
        return new Response(JSON.stringify({ token: 'attacker-issued' }), {
          status: 200,
        });
      }
      return challenge('https://evil.example/token');
    }) as unknown as typeof fetch;

    const auth = new BearerTokenAuthentication({
      fetch: fetchImplementation,
      credentials: { username: 'alice', password: 'hunter2' },
      registryOrigin: 'https://registry.test',
    });
    await expect(
      auth.headers(
        new URL('https://registry.test/v2/demo/tags/list'),
        'repository:demo:pull',
      ),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(contacted, 'nothing may reach the attacker').toEqual([]);
  });

  it('allows a registry that issues its own tokens', async () => {
    const fetchImplementation = (async (
      url: URL | string,
      init?: RequestInit,
    ) => {
      const href = String(url);
      if (href.includes('/token'))
        return new Response(JSON.stringify({ token: 'ok' }), { status: 200 });
      if (new Headers(init?.headers).get('authorization') === 'Bearer ok')
        return new Response(JSON.stringify({ tags: ['1.0'] }), { status: 200 });
      return challenge('https://registry.test/token');
    }) as unknown as typeof fetch;
    const auth = new BearerTokenAuthentication({
      fetch: fetchImplementation,
      credentials: { username: 'alice', password: 'hunter2' },
      registryOrigin: 'https://registry.test',
    });
    await expect(
      auth.headers(new URL('https://registry.test/v2/demo/tags/list'), 's'),
    ).resolves.toMatchObject({ authorization: 'Bearer ok' });
  });

  it('allows a delegation the caller explicitly authorized', async () => {
    const fetchImplementation = (async (url: URL | string) =>
      String(url).startsWith('https://auth.internal/')
        ? new Response(JSON.stringify({ token: 'ok' }), { status: 200 })
        : challenge('https://auth.internal/token')) as unknown as typeof fetch;
    const auth = new BearerTokenAuthentication({
      fetch: fetchImplementation,
      credentials: { username: 'alice', password: 'hunter2' },
      registryOrigin: 'https://registry.test',
      allowedTokenOrigins: ['https://auth.internal'],
    });
    await expect(
      auth.headers(new URL('https://registry.test/v2/demo/tags/list'), 's'),
    ).resolves.toMatchObject({ authorization: 'Bearer ok' });
  });

  it('rejects a different registry before contacting it', async () => {
    const contacted: string[] = [];
    const auth = new BearerTokenAuthentication({
      fetch: (async (url: URL | string) => {
        contacted.push(String(url));
        return new Response(null, { status: 200 });
      }) as unknown as typeof fetch,
      credentials: { username: 'alice', password: 'hunter2' },
      registryOrigin: 'https://registry.test',
    });
    await expect(
      auth.headers(new URL('https://evil.example/v2/demo/tags/list'), 's'),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(contacted).toEqual([]);
  });

  it('rejects an unconfigured anonymous token origin before contacting it', async () => {
    const contacted: string[] = [];
    const fetchImplementation = (async (url: URL | string) =>
      String(url).startsWith('https://auth.elsewhere/')
        ? (contacted.push(String(url)),
          new Response(JSON.stringify({ token: 'anon' }), { status: 200 }))
        : challenge('https://auth.elsewhere/token')) as unknown as typeof fetch;
    const auth = new BearerTokenAuthentication({ fetch: fetchImplementation });
    await expect(
      auth.headers(new URL('https://registry.test/v2/demo/tags/list'), 's'),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(contacted).toEqual([]);
  });

  it('does not follow redirects from an authorized token origin', async () => {
    const contacted: string[] = [];
    const fetchImplementation = (async (
      url: URL | string,
      init?: RequestInit,
    ) => {
      const href = String(url);
      contacted.push(href);
      if (href.startsWith('https://auth.internal/')) {
        expect(init?.redirect).toBe('manual');
        return new Response(null, {
          status: 302,
          headers: { location: 'https://evil.example/token' },
        });
      }
      return challenge('https://auth.internal/token');
    }) as unknown as typeof fetch;
    const auth = new BearerTokenAuthentication({
      fetch: fetchImplementation,
      allowedTokenOrigins: ['https://auth.internal'],
    });
    await expect(
      auth.headers(new URL('https://registry.test/v2/demo/tags/list'), 's'),
    ).rejects.toMatchObject({ code: 'UNSAFE_REDIRECT' });
    expect(contacted).toEqual([
      'https://registry.test/v2/demo/tags/list',
      'https://auth.internal/token?service=registry.test&scope=s',
    ]);
  });

  it.each([
    JSON.stringify({ token: 'x'.repeat(70 * 1024) }),
    JSON.stringify({ token: 'x'.repeat(16_385) }),
    '{"token":"ok","expires_in":1e309}',
  ])('rejects an oversized or invalid token response', async (body) => {
    const fetchImplementation = (async (url: URL | string) =>
      String(url).includes('/token')
        ? new Response(body, { status: 200 })
        : challenge('https://registry.test/token')) as unknown as typeof fetch;
    const auth = new BearerTokenAuthentication({ fetch: fetchImplementation });
    await expect(
      auth.headers(new URL('https://registry.test/v2/demo/tags/list'), 's'),
    ).rejects.toBeTruthy();
  });

  it('refuses a plaintext token endpoint even anonymously', async () => {
    const fetchImplementation = (async () =>
      challenge('http://registry.test/token')) as unknown as typeof fetch;
    const auth = new BearerTokenAuthentication({ fetch: fetchImplementation });
    await expect(
      auth.headers(new URL('https://registry.test/v2/demo/tags/list'), 's'),
    ).rejects.toMatchObject({ code: 'UNSAFE_REDIRECT' });
  });
});
