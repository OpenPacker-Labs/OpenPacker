import { describe, expect, it } from 'vitest';
import { canonicalDigest, formatDigest } from '@openpacker/canonical';
import { Ed25519Signer } from '@openpacker/trust';
import type { HttpRequest, HttpResponse } from '@openpacker/adapter-core';
import type { JsonValue } from '@openpacker/contracts';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Read rather than import: this file is typechecked, and a JSON module import
// would need a resolution attribute that says nothing useful about the test.
// SAFETY: The surrounding boundary establishes the asserted domain contract.
const keys = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('../../../fixtures/trust/keys.json', import.meta.url),
    ),
    'utf8',
  ),
) as Record<string, JsonWebKey>;
import { PrexRegistryProvider, RegistryClient, WELL_KNOWN } from './index.js';

const BASE = 'https://registry.example';

const ALL_RESOURCES = [
  'prex.registry.search/1',
  'prex.registry.enumerate-versions/1',
  'prex.registry.package-manifest/1',
  'prex.registry.sync/1',
];

function definition(resources: readonly string[] = ALL_RESOURCES) {
  return {
    registryDefinitionVersion: '1',
    registryId: 'urn:openpacker:registry:example',
    displayName: 'example',
    purlTypes: ['npm', 'pypi'],
    resources: [{ '@id': `${BASE}/v1`, '@type': [...resources] }],
  };
}

function manifest(name = 'demo-tool', version = '1.2.3') {
  return {
    packageManifestVersion: '1' as const,
    name,
    version,
    distributions: [
      {
        purlType: 'npm',
        identifier: name,
        version,
        exactPurl: `pkg:npm/${name}@${version}`,
        digest: { algorithm: 'sha256' as const, value: '3'.repeat(64) },
        size: 10,
        mediaType: 'application/vnd.npm.install-v1+json',
        locations: [
          `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
        ],
      },
    ],
  };
}

/** A registry that answers from a route table, so no network is involved. */
function fixtureTransport(routes: Record<string, unknown>) {
  const calls: string[] = [];
  const transport = {
    async request(request: HttpRequest): Promise<HttpResponse> {
      calls.push(request.url);
      const key = request.url.replace(BASE, '');
      const body = routes[key];
      if (body === undefined)
        // SAFETY: The surrounding boundary establishes the asserted domain contract.
        return {
          status: 404,
          headers: {},
          body: new TextEncoder().encode('{}'),
          url: request.url,
        } as HttpResponse;
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: new TextEncoder().encode(JSON.stringify(body)),
        url: request.url,
      } as HttpResponse;
    },
  };
  return { transport, calls };
}

async function entryFor(
  value = manifest(),
  options: { sign?: boolean; digestOverride?: string } = {},
) {
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  const digest = await canonicalDigest(value as unknown as JsonValue);
  const signatures = [];
  if (options.sign) {
    const signer = await Ed25519Signer.fromJwk('publisher-1', keys.leaf!);
    signatures.push({
      algorithm: 'ed25519' as const,
      keyId: 'publisher-1',
      signature: await signer.sign(
        new TextEncoder().encode(formatDigest(digest)),
      ),
      role: 'publisher' as const,
    });
  }
  return {
    manifest: value,
    registryMetadata: {
      registryId: 'urn:openpacker:registry:example',
      status: 'active' as const,
      publishedAt: '2026-08-10T00:00:00.000Z',
      isLatest: true,
      manifestDigest:
        options.digestOverride === undefined
          ? digest
          : { algorithm: 'sha256' as const, value: options.digestOverride },
    },
    ...(signatures.length > 0 && { signatures }),
  };
}

describe('RegistryClient discovery', () => {
  it('refuses a registry that is neither https nor loopback', () => {
    expect(
      () => new RegistryClient({ baseUrl: 'http://registry.example' }),
    ).toThrow(/https, or loopback/u);
    expect(
      () => new RegistryClient({ baseUrl: 'http://127.0.0.1:7400' }),
    ).not.toThrow();
  });

  it('keeps package identifiers inside the package route', async () => {
    const { transport, calls } = fixtureTransport({
      '/.well-known/prex-registry': definition(),
    });
    const client = new RegistryClient({ baseUrl: BASE, transport });
    await expect(client.versions('../admin')).rejects.toMatchObject({
      code: 'INVALID_PURL',
    });
    expect(calls).toEqual([`${BASE}/.well-known/prex-registry`]);
  });

  it('refuses a registry speaking a version it does not know', async () => {
    const { transport } = fixtureTransport({
      '/.well-known/prex-registry': {
        ...definition(),
        registryDefinitionVersion: '2',
      },
    });
    const client = new RegistryClient({ baseUrl: BASE, transport });
    await expect(client.definition()).rejects.toMatchObject({
      code: 'UNSUPPORTED_PROVIDER',
    });
  });

  it('refuses an operation the registry does not advertise', async () => {
    // The registry serves manifests but never claims to be searchable.
    const { transport } = fixtureTransport({
      '/.well-known/prex-registry': definition([
        'prex.registry.package-manifest/1',
      ]),
    });
    const client = new RegistryClient({ baseUrl: BASE, transport });
    await expect(client.list({ search: 'demo' })).rejects.toMatchObject({
      code: 'PROVIDER_CAPABILITY_MISSING',
    });
  });

  it('reads the service index once and reuses it', async () => {
    const { transport, calls } = fixtureTransport({
      '/.well-known/prex-registry': definition(),
      '/v1/packages/demo-tool/versions': { name: 'demo-tool', versions: [] },
    });
    const client = new RegistryClient({ baseUrl: BASE, transport });
    await client.versions('demo-tool');
    await client.versions('demo-tool');
    expect(
      calls.filter((url) => url.endsWith('/.well-known/prex-registry')),
    ).toHaveLength(1);
  });

  it('rejects oversized and excessively nested definitions before use', async () => {
    const oversized = new RegistryClient({
      baseUrl: BASE,
      transport: {
        async request(request) {
          return {
            status: 200,
            headers: {},
            body: new Uint8Array(256 * 1024 + 1),
            url: request.url,
          };
        },
      },
    });
    await expect(oversized.definition()).rejects.toThrow(
      /exceeds 262144 bytes/u,
    );

    let nested: unknown = 'leaf';
    for (let depth = 0; depth < 66; depth += 1) nested = { nested };
    const { transport } = fixtureTransport({
      '/.well-known/prex-registry': { ...definition(), nested },
    });
    await expect(
      new RegistryClient({ baseUrl: BASE, transport }).definition(),
    ).rejects.toThrow(/more than 64 levels/u);
  });
});

describe('RegistryClient pagination', () => {
  it('walks cursors to the end', async () => {
    const first = await entryFor(manifest('a'));
    const second = await entryFor(manifest('b'));
    const { transport } = fixtureTransport({
      '/.well-known/prex-registry': definition(),
      '/v1/packages': {
        packages: [first],
        metadata: { count: 1, nextCursor: 'page2' },
      },
      '/v1/packages?cursor=page2': {
        packages: [second],
        metadata: { count: 1, nextCursor: null },
      },
    });
    const client = new RegistryClient({ baseUrl: BASE, transport });
    const names: string[] = [];
    for await (const entry of client.listAll()) names.push(entry.manifest.name);
    expect(names).toEqual(['a', 'b']);
  });

  it('keeps walking past an empty page while a cursor remains', async () => {
    const last = await entryFor(manifest('late'));
    const { transport } = fixtureTransport({
      '/.well-known/prex-registry': definition(),
      // A federating registry may return this while a slow source answers.
      '/v1/packages': {
        packages: [],
        metadata: { count: 0, nextCursor: 'p2' },
      },
      '/v1/packages?cursor=p2': {
        packages: [last],
        metadata: { count: 1, nextCursor: null },
      },
    });
    const client = new RegistryClient({ baseUrl: BASE, transport });
    const names: string[] = [];
    for await (const entry of client.listAll()) names.push(entry.manifest.name);
    expect(names).toEqual(['late']);
  });

  it('refuses to loop when a registry repeats a cursor', async () => {
    const { transport } = fixtureTransport({
      '/.well-known/prex-registry': definition(),
      '/v1/packages': {
        packages: [],
        metadata: { count: 0, nextCursor: 'same' },
      },
      '/v1/packages?cursor=same': {
        packages: [],
        metadata: { count: 0, nextCursor: 'same' },
      },
    });
    const client = new RegistryClient({ baseUrl: BASE, transport });
    await expect(async () => {
      for await (const _ of client.listAll()) void _;
    }).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE' });
  });

  it('bounds unique pages, entries, bytes, and cursor length before yielding excess data', async () => {
    const one = await entryFor(manifest('one'));
    const two = await entryFor(manifest('two'));
    const cases = [
      {
        limits: { maximumPages: 1 },
        page: { packages: [one], metadata: { count: 1, nextCursor: 'next' } },
        expected: /pages/u,
      },
      {
        limits: { maximumEntries: 1 },
        page: {
          packages: [one, two],
          metadata: { count: 2, nextCursor: null },
        },
        expected: /entries/u,
      },
      {
        limits: { maximumBytes: 1 },
        page: { packages: [], metadata: { count: 0, nextCursor: null } },
        expected: /bytes/u,
      },
      {
        limits: { maximumCursorLength: 3 },
        page: { packages: [], metadata: { count: 0, nextCursor: 'long' } },
        expected: /cursor/u,
      },
    ] as const;
    for (const testCase of cases) {
      const { transport } = fixtureTransport({
        '/.well-known/prex-registry': definition(),
        '/v1/packages': testCase.page,
      });
      const client = new RegistryClient({
        baseUrl: BASE,
        transport,
        paginationLimits: testCase.limits,
      });
      await expect(async () => {
        for await (const _entry of client.listAll()) void _entry;
      }).rejects.toThrow(testCase.expected);
    }
  });

  it('imposes a pagination deadline when the caller omits one', async () => {
    const transport = {
      async request(request: HttpRequest): Promise<HttpResponse> {
        if (request.url.endsWith('/.well-known/prex-registry'))
          return {
            status: 200,
            headers: {},
            body: new TextEncoder().encode(JSON.stringify(definition())),
            url: request.url,
          };
        return new Promise((_resolve, reject) => {
          const abort = () => reject(request.signal?.reason);
          request.signal?.addEventListener('abort', abort, { once: true });
          if (request.signal?.aborted) abort();
        });
      },
    };
    const client = new RegistryClient({
      baseUrl: BASE,
      transport,
      paginationLimits: { maximumElapsedMilliseconds: 5 },
    });
    await expect(async () => {
      for await (const _entry of client.listAll()) void _entry;
    }).rejects.toThrow(/milliseconds/u);
  });

  it('passes the aggregate remaining byte budget to each page request', async () => {
    const maxima: number[] = [];
    let page = 0;
    const transport = {
      async request(request: HttpRequest): Promise<HttpResponse> {
        const body = request.url.endsWith(WELL_KNOWN)
          ? definition()
          : {
              packages: [],
              metadata: {
                count: 0,
                nextCursor: page++ === 0 ? 'next' : null,
              },
            };
        if (request.url.includes('/v1/packages'))
          maxima.push(request.maximumBytes!);
        return {
          status: 200,
          headers: {},
          body: new TextEncoder().encode(JSON.stringify(body)),
          url: request.url,
        };
      },
    };
    const client = new RegistryClient({
      baseUrl: BASE,
      transport,
      paginationLimits: { maximumBytes: 512 },
    });
    for await (const _entry of client.listAll()) void _entry;
    expect(maxima).toHaveLength(2);
    expect(maxima[0]).toBe(512);
    expect(maxima[1]).toBeLessThan(512);
  });
});

describe('RegistryClient verification', () => {
  it('refuses an entry whose manifest does not hash to the stated digest', async () => {
    const entry = await entryFor(manifest(), {
      digestOverride: 'f'.repeat(64),
    });
    const { transport } = fixtureTransport({
      '/.well-known/prex-registry': definition(),
      '/v1/packages/demo-tool/versions/1.2.3': entry,
    });
    const client = new RegistryClient({ baseUrl: BASE, transport });
    // The registry contradicting itself is worse than saying nothing.
    await expect(
      client.entry('demo-tool', '1.2.3').then((e) => client.verifyEntry(e)),
    ).rejects.toMatchObject({ code: 'DIGEST_MISMATCH' });
  });

  it('verifies a publisher signature against a configured key', async () => {
    const entry = await entryFor(manifest(), { sign: true });
    const { transport } = fixtureTransport({
      '/.well-known/prex-registry': definition(),
      '/v1/packages/demo-tool/versions/1.2.3': entry,
    });
    const client = new RegistryClient({
      baseUrl: BASE,
      transport,
      keys: { 'publisher-1': keys.leaf! },
    });
    const result = await client.verifyEntry(
      await client.entry('demo-tool', '1.2.3'),
    );
    expect(result.digestMatches).toBe(true);
    expect(result.signatures).toEqual([
      { keyId: 'publisher-1', role: 'publisher', status: 'valid' },
    ]);
  });

  it('reports an unknown key rather than treating it as verified', async () => {
    const entry = await entryFor(manifest(), { sign: true });
    const { transport } = fixtureTransport({
      '/.well-known/prex-registry': definition(),
      '/v1/packages/demo-tool/versions/1.2.3': entry,
    });
    // No keys configured: signatures are read, not checked, and saying so is
    // the difference between "unverified" and "verified".
    const client = new RegistryClient({ baseUrl: BASE, transport });
    const result = await client.verifyEntry(
      await client.entry('demo-tool', '1.2.3'),
    );
    expect(result.signatures[0]?.status).toBe('unknown-key');
  });

  it('refuses a signature that does not hold', async () => {
    const entry = await entryFor(manifest(), { sign: true });
    const tampered = {
      ...entry,
      signatures: [
        { ...entry.signatures![0]!, signature: 'AAAAAAAAAAAAAAAAAAAAAA==' },
      ],
    };
    const { transport } = fixtureTransport({
      '/.well-known/prex-registry': definition(),
      '/v1/packages/demo-tool/versions/1.2.3': tampered,
    });
    const client = new RegistryClient({
      baseUrl: BASE,
      transport,
      keys: { 'publisher-1': keys.leaf! },
    });
    await expect(
      client.entry('demo-tool', '1.2.3').then((e) => client.verifyEntry(e)),
    ).rejects.toMatchObject({ code: 'INVALID_SIGNATURE' });
  });
});

describe('PrexRegistryProvider as an opm source', () => {
  const routes = async () => ({
    '/.well-known/prex-registry': definition(),
    '/v1/packages/demo-tool/versions': {
      name: 'demo-tool',
      versions: [
        { version: '1.2.3', status: 'active', isLatest: true },
        { version: '1.0.0', status: 'deleted', isLatest: false },
      ],
    },
    '/v1/packages/demo-tool/versions/1.2.3': await entryFor(),
  });

  it('enumerates active versions and leaves withdrawn ones out', async () => {
    const { transport } = fixtureTransport(await routes());
    const provider = new PrexRegistryProvider(
      new RegistryClient({ baseUrl: BASE, transport }),
    );
    // A withdrawn version stays retrievable by exact version, but must not be
    // offered as something to solve against.
    expect(await provider.enumerate('pkg:npm/demo-tool')).toEqual([
      'pkg:npm/demo-tool@1.2.3',
    ]);
  });

  it('inspects an exact purl through the registry', async () => {
    const { transport } = fixtureTransport(await routes());
    const provider = new PrexRegistryProvider(
      new RegistryClient({ baseUrl: BASE, transport }),
    );
    const inspection = await provider.inspect('pkg:npm/demo-tool@1.2.3');
    expect(inspection.package.identity.exactPurl).toBe(
      'pkg:npm/demo-tool@1.2.3',
    );
  });

  it('rejects a registry distribution that substitutes package identity', async () => {
    const substituted = await entryFor(manifest('other-tool'));
    const { transport } = fixtureTransport({
      ...(await routes()),
      '/v1/packages/demo-tool/versions/1.2.3': substituted,
    });
    const provider = new PrexRegistryProvider(
      new RegistryClient({ baseUrl: BASE, transport }),
    );
    await expect(
      provider.inspect('pkg:npm/demo-tool@1.2.3'),
    ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_METADATA' });
  });

  it('points at the upstream location rather than pretending to serve bytes', async () => {
    const { transport } = fixtureTransport(await routes());
    const provider = new PrexRegistryProvider(
      new RegistryClient({ baseUrl: BASE, transport }),
    );
    const record = await provider.fetchArtifactRecord(
      'pkg:npm/demo-tool@1.2.3',
    );
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const body = record.body as { locations: { uri: string }[] };
    expect(body.locations[0]?.uri).toContain('registry.npmjs.org');
  });

  it('refuses a purl type this release was not published for', async () => {
    const { transport } = fixtureTransport(await routes());
    const provider = new PrexRegistryProvider(
      new RegistryClient({ baseUrl: BASE, transport }),
    );
    await expect(
      provider.inspect('pkg:pypi/demo-tool@1.2.3'),
    ).rejects.toMatchObject({ code: 'PACKAGE_NOT_FOUND' });
  });
});

describe('RegistryClient revocation', () => {
  const withRevocation = async (
    revoked: unknown[],
    publishedAt = '2026-08-10T00:00:00.000Z',
    serial = 1,
  ) => {
    const entry = await entryFor(manifest(), { sign: true });
    const dated = {
      ...entry,
      registryMetadata: { ...entry.registryMetadata, publishedAt },
    };
    return fixtureTransport({
      '/.well-known/prex-registry': definition([
        ...ALL_RESOURCES,
        'prex.registry.key-lifecycle/1',
      ]),
      '/v1/packages/demo-tool/versions/1.2.3': dated,
      '/v1/revocations': await signedRevocationList(revoked, serial),
    });
  };

  it('reports revoked, not invalid, for a signature the key no longer backs', async () => {
    const { transport } = await withRevocation([
      {
        keyId: 'publisher-1',
        revokedAt: '2026-08-01T00:00:00.000Z',
        effective: 'retroactive',
        reason: 'compromised',
      },
    ]);
    const client = new RegistryClient({
      baseUrl: BASE,
      transport,
      keys: { 'publisher-1': keys.leaf! },
      registryKeys: { 'test-registry': keys.root! },
    });
    const result = await client.verifyEntry(
      await client.entry('demo-tool', '1.2.3'),
    );
    // "Forged" and "was good, key since withdrawn" are different facts, and a
    // consumer's policy may accept one and not the other.
    expect(result.signatures[0]?.status).toBe('revoked');
  });

  it('keeps a signature made before a from-now revocation', async () => {
    const { transport } = await withRevocation(
      [
        {
          keyId: 'publisher-1',
          revokedAt: '2026-08-11T00:00:00.000Z',
          effective: 'from-now',
          reason: 'rotated',
        },
      ],
      '2026-08-10T00:00:00.000Z',
    );
    const client = new RegistryClient({
      baseUrl: BASE,
      transport,
      keys: { 'publisher-1': keys.leaf! },
      registryKeys: { 'test-registry': keys.root! },
    });
    const result = await client.verifyEntry(
      await client.entry('demo-tool', '1.2.3'),
    );
    // A routine rotation must not break every lockfile pinning what this key
    // signed before it was retired.
    expect(result.signatures[0]?.status).toBe('valid');
  });

  it('revokes a signature made after a from-now revocation', async () => {
    const { transport } = await withRevocation(
      [
        {
          keyId: 'publisher-1',
          revokedAt: '2026-08-01T00:00:00.000Z',
          effective: 'from-now',
        },
      ],
      '2026-08-10T00:00:00.000Z',
    );
    const client = new RegistryClient({
      baseUrl: BASE,
      transport,
      keys: { 'publisher-1': keys.leaf! },
      registryKeys: { 'test-registry': keys.root! },
    });
    const result = await client.verifyEntry(
      await client.entry('demo-tool', '1.2.3'),
    );
    expect(result.signatures[0]?.status).toBe('revoked');
  });

  it('reports whether the registry does revocation at all', async () => {
    const { transport } = fixtureTransport({
      '/.well-known/prex-registry': definition(),
    });
    const client = new RegistryClient({ baseUrl: BASE, transport });
    const result = await client.revocations();
    // "No list" is not "nothing is revoked", and a consumer may reasonably
    // decline to trust a registry that cannot say.
    expect(result).toEqual({ entries: [], known: false });
  });

  it('re-reads the revocation list rather than caching it forever', async () => {
    let revoked: unknown[] = [];
    let serial = 1;
    let now = 0;
    const transport = revocationTransport(() => ({ serial, revoked }));
    const client = new RegistryClient({
      baseUrl: BASE,
      transport,
      registryKeys: { 'test-registry': keys.root! },
      revocationTtlMilliseconds: 1000,
      clock: () => now,
    });
    expect((await client.revocations()).entries).toEqual([]);

    revoked = [
      {
        keyId: 'publisher-1',
        revokedAt: '2026-08-11T00:00:00.000Z',
        effective: 'retroactive',
      },
    ];
    serial = 2;
    // Still cached: within the TTL.
    expect((await client.revocations()).entries).toEqual([]);
    now = 1000;
    // A client that cached forever would never learn about a compromise, which
    // is the entire point of revocation.
    expect((await client.revocations()).entries).toHaveLength(1);
  });

  it('refuses a revocation list older than one it has already seen', async () => {
    let serial = 7;
    let now = 0;
    const transport = revocationTransport(() => ({ serial, revoked: [] }));
    const client = new RegistryClient({
      baseUrl: BASE,
      transport,
      registryKeys: { 'test-registry': keys.root! },
      revocationTtlMilliseconds: 1000,
      clock: () => now,
    });
    expect((await client.revocations()).known).toBe(true);

    serial = 3;
    now = 1000;
    // A replayed older list would pin a consumer to the state of the world
    // from before a compromise.
    await expect(client.revocations()).rejects.toMatchObject({
      code: 'STALE_METADATA',
    });
  });

  it.each(['digest', 'signature', 'registry', 'expiry'] as const)(
    'rejects unauthenticated revocation metadata with a bad %s',
    async (bad) => {
      const document = await signedRevocationList([], 1, {
        ...(bad === 'registry' && {
          registryId: 'urn:openpacker:registry:other',
        }),
        ...(bad === 'expiry' && { expiresAt: '2026-08-10T00:00:00.000Z' }),
      });
      if (bad === 'digest') document.listDigest.value = '0'.repeat(64);
      if (bad === 'signature') document.signatures[0]!.signature = 'AAAA';
      const { transport } = fixtureTransport({
        '/.well-known/prex-registry': definition([
          ...ALL_RESOURCES,
          'prex.registry.key-lifecycle/1',
        ]),
        '/v1/revocations': document,
      });
      const client = new RegistryClient({
        baseUrl: BASE,
        transport,
        registryKeys: { 'test-registry': keys.root! },
      });
      await expect(client.revocations()).rejects.toBeTruthy();
    },
  );

  it('does not let a publisher key authenticate registry metadata', async () => {
    const document = await signedRevocationList([], 1);
    const signer = await Ed25519Signer.fromJwk('publisher-1', keys.leaf!);
    document.signatures = [
      {
        algorithm: 'ed25519',
        keyId: 'publisher-1',
        signature: await signer.sign(
          new TextEncoder().encode(formatDigest(document.listDigest)),
        ),
        role: 'registry',
      },
    ];
    const { transport } = fixtureTransport({
      '/.well-known/prex-registry': definition([
        ...ALL_RESOURCES,
        'prex.registry.key-lifecycle/1',
      ]),
      '/v1/revocations': document,
    });
    const client = new RegistryClient({
      baseUrl: BASE,
      transport,
      keys: { 'publisher-1': keys.leaf! },
    });
    await expect(client.revocations()).rejects.toMatchObject({
      code: 'INVALID_SIGNATURE',
    });
  });
});

async function signedRevocationList(
  revoked: unknown[],
  serial: number,
  options: { registryId?: string; issuedAt?: string; expiresAt?: string } = {},
) {
  const list = {
    revocationListVersion: '1' as const,
    registryId: options.registryId ?? 'urn:openpacker:registry:example',
    serial,
    issuedAt: options.issuedAt ?? '2026-08-11T00:00:00.000Z',
    expiresAt: options.expiresAt ?? '2099-01-01T00:00:00.000Z',
    revoked,
  };
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  const listDigest = await canonicalDigest(list as unknown as JsonValue);
  const signer = await Ed25519Signer.fromJwk('test-registry', keys.root!);
  return {
    list,
    listDigest,
    signatures: [
      {
        algorithm: 'ed25519' as const,
        keyId: 'test-registry',
        signature: await signer.sign(
          new TextEncoder().encode(formatDigest(listDigest)),
        ),
        role: 'registry' as const,
      },
    ],
  };
}

/** A transport whose revocation list is produced fresh on every read. */
function revocationTransport(
  current: () => { serial: number; revoked: unknown[] },
) {
  return {
    async request(request: HttpRequest): Promise<HttpResponse> {
      const state = current();
      const body = request.url.endsWith('/v1/revocations')
        ? await signedRevocationList(state.revoked, state.serial, {
            issuedAt: '1970-01-01T00:00:00.000Z',
          })
        : definition([...ALL_RESOURCES, 'prex.registry.key-lifecycle/1']);
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: new TextEncoder().encode(JSON.stringify(body)),
        url: request.url,
      } as HttpResponse;
    },
  };
}
