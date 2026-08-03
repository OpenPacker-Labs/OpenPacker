import { describe, expect, it } from 'vitest';
import {
  OpenPackerClient,
  PrexClientError,
  UnsupportedProtocolVersionError,
} from '../src/index.js';

const capabilities = {
  meta: {
    protocolVersion: '1.0-draft',
    provider: {
      id: 'fixture',
      implementation: 'openpackerd',
      version: '0.1.0',
    },
  },
  protocolVersions: ['1.0-draft'],
  operations: [],
  conformanceLevels: [],
  purlTypes: [],
  versSchemes: [],
  semanticsProfiles: [],
  targetDimensions: [],
  evidenceTypes: [],
  artifactTransports: [],
  contentEncodings: [],
  eventBindings: [],
  limits: {
    requestBytes: 1,
    batchItems: 1,
    universeNodes: 1,
    graphNodes: 1,
    artifactMetadataBytes: 1,
  },
  pagination: { supported: true, maximumPageSize: 1 },
  streaming: { supported: true, bindings: ['ndjson'] },
  authenticationSchemes: [{ type: 'none' }],
  extensionSchemaRefs: [],
} as const;

describe('OpenPackerClient', () => {
  it("returns parsed data and the server's exact bytes", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify(capabilities));
    const client = new OpenPackerClient({
      fetch: async () => new Response(bytes),
    });
    const result = await client.capabilities();
    expect(result.data.meta.protocolVersion).toBe('1.0-draft');
    expect(result.rawBytes).toEqual(bytes);
  });

  it('preserves RFC 9457 errors', async () => {
    const problem = {
      type: 'https://openpacker.dev/problems/package-not-found',
      title: 'Not found',
      status: 404,
      code: 'PACKAGE_NOT_FOUND',
      retryable: false,
    };
    const client = new OpenPackerClient({
      fetch: async () => Response.json(problem, { status: 404 }),
    });
    await expect(
      client.receipt('sha256', 'a'.repeat(64)),
    ).rejects.toMatchObject<Partial<PrexClientError>>({ status: 404, problem });
  });

  it('rejects unsupported protocol major versions from headers or bodies', async () => {
    const headerClient = new OpenPackerClient({
      fetch: async () =>
        Response.json(capabilities, { headers: { 'prex-version': '2.0' } }),
    });
    await expect(headerClient.capabilities()).rejects.toBeInstanceOf(
      UnsupportedProtocolVersionError,
    );

    const bodyClient = new OpenPackerClient({
      fetch: async () =>
        Response.json({
          ...capabilities,
          meta: { ...capabilities.meta, protocolVersion: '2.0' },
        }),
    });
    await expect(bodyClient.capabilities()).rejects.toBeInstanceOf(
      UnsupportedProtocolVersionError,
    );
  });

  it('parses canonical NDJSON event bytes', async () => {
    const event = {
      specversion: '1.0',
      id: 'e',
      source: 'urn:test',
      type: 'org.openpacker.receipt.created',
      subject: 'sha256:x',
      time: '2026-01-01T00:00:00Z',
      datacontenttype: 'application/json',
      dataschema: 'urn:schema',
      datadigest: `sha256:${'0'.repeat(64)}`,
      correlationid: 'c',
      data: {
        schemaVersion: '1',
        receiptDigest: { algorithm: 'sha256', value: '0'.repeat(64) },
      },
      externalrefs: [],
    };
    const line = JSON.stringify(event);
    const client = new OpenPackerClient({
      fetch: async () =>
        new Response(`${line}\n`, {
          headers: {
            'content-type': 'application/x-ndjson',
            'x-openpacker-next-cursor': '1',
          },
        }),
    });
    const found = [];
    for await (const item of client.events()) found.push(item);
    expect(new TextDecoder().decode(found[0]?.rawBytes)).toBe(line);
  });

  it('replays bounded event pages using server cursors', async () => {
    const cursors: string[] = [];
    const event = {
      specversion: '1.0',
      id: 'e',
      source: 'urn:test',
      type: 'org.openpacker.receipt.created',
      subject: 'sha256:x',
      time: '2026-01-01T00:00:00Z',
      datacontenttype: 'application/json',
      dataschema: 'urn:schema',
      datadigest: `sha256:${'0'.repeat(64)}`,
      correlationid: 'c',
      data: { schemaVersion: '1' },
      externalrefs: [],
    };
    const line = JSON.stringify(event);
    const client = new OpenPackerClient({
      fetch: async (input) => {
        const cursor = new URL(input.toString()).searchParams.get('cursor')!;
        cursors.push(cursor);
        return new Response(cursor === '0' ? `${line}\n` : '', {
          headers: { 'x-openpacker-next-cursor': cursor === '0' ? '4' : '4' },
        });
      },
    });
    const found = [];
    for await (const item of client.events(0, { pageSize: 1 }))
      found.push(item);
    expect(found).toHaveLength(1);
    expect(cursors).toEqual(['0', '4']);
  });

  it('exposes every normative and OpenPacker extension route', async () => {
    const paths: string[] = [];
    const client = new OpenPackerClient({
      fetch: async (input) => {
        paths.push(new URL(input.toString()).pathname);
        return Response.json({});
      },
    });
    await client.discovery();
    await client.capabilities();
    await client.health();
    await client.ready();
    await client.normalize({} as never);
    await client.identify({} as never);
    await client.enumerate({} as never);
    await client.inspect({} as never);
    await client.solve({} as never);
    await client.materialize({} as never);
    await client.verify({} as never);
    await client.explain({} as never);
    await client.receipt('sha256', 'a'.repeat(64));
    await client.snapshot('sha256', 'b'.repeat(64));
    await client.catalogImport({} as never);
    await client.catalogSnapshot({});
    await client.lifecycleApply({} as never);
    await client.pack({} as never);
    await client.publish({} as never);
    expect(paths).toEqual([
      '/.well-known/prex',
      '/v1/capabilities',
      '/v1/health',
      '/v1/ready',
      '/v1/normalize',
      '/v1/identify',
      '/v1/enumerate',
      '/v1/inspect',
      '/v1/solve',
      '/v1/materialize',
      '/v1/verify',
      '/v1/explain',
      `/v1/receipts/sha256/${'a'.repeat(64)}`,
      `/v1/snapshots/sha256/${'b'.repeat(64)}`,
      '/v1/openpacker/catalog/import',
      '/v1/openpacker/catalog/snapshot',
      '/v1/openpacker/lifecycle/apply',
      '/v1/openpacker/pack',
      '/v1/openpacker/publish',
    ]);
  });

  it('applies authentication, tracing, retries, timeout, and caller headers', async () => {
    const requests: Array<{ url: string; headers: Headers }> = [];
    const client = new OpenPackerClient({
      baseUrl: 'https://prex.example/base/',
      headers: { 'x-client': 'fixture' },
      userAgent: 'openpacker-test/1',
      retries: 1,
      authenticate: () => ({ authorization: 'Bearer fixture' }),
      fetch: async (input, init) => {
        requests.push({
          url: input.toString(),
          headers: new Headers(init?.headers),
        });
        return requests.length === 1
          ? Response.json({}, { status: 503 })
          : Response.json({});
      },
    });
    await client.normalize({} as never, {
      idempotencyKey: 'retry-safe',
      correlationId: 'correlation',
      traceparent: '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01',
      tracestate: 'vendor=value',
      headers: { 'x-request': 'fixture' },
    });
    expect(requests).toHaveLength(2);
    expect(requests[1]?.url).toBe('https://prex.example/base/v1/normalize');
    expect(Object.fromEntries(requests[1]!.headers)).toMatchObject({
      authorization: 'Bearer fixture',
      'idempotency-key': 'retry-safe',
      traceparent: '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01',
      tracestate: 'vendor=value',
      'user-agent': 'openpacker-test/1',
      'x-client': 'fixture',
      'x-correlation-id': 'correlation',
      'x-request': 'fixture',
    });

    const timeoutClient = new OpenPackerClient({
      fetch: async (_input, init) =>
        new Promise((_resolve, reject) =>
          init?.signal?.addEventListener('abort', () =>
            reject(init.signal?.reason),
          ),
        ),
    });
    await expect(
      timeoutClient.health({ timeoutMilliseconds: 1 }),
    ).rejects.toMatchObject({ name: 'TimeoutError' });
  });
});
