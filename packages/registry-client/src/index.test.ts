import { describe, expect, it } from 'vitest';
import { canonicalDigest, formatDigest } from '@openpacker/canonical';
import { Ed25519Signer } from '@openpacker/trust';
import type { HttpRequest, HttpResponse } from '@openpacker/adapter-core';
import type { JsonValue } from '@openpacker/contracts';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Read rather than import: this file is typechecked, and a JSON module import
// would need a resolution attribute that says nothing useful about the test.
const keys = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('../../../fixtures/trust/keys.json', import.meta.url),
    ),
    'utf8',
  ),
) as Record<string, JsonWebKey>;
import { PrexRegistryProvider, RegistryClient } from './index.js';

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
        return {
          status: 404,
          headers: {},
          body: new TextEncoder().encode('{}'),
          url: request.url,
        } as HttpResponse;
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
    ...(signatures.length > 0 ? { signatures } : {}),
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

  it('points at the upstream location rather than pretending to serve bytes', async () => {
    const { transport } = fixtureTransport(await routes());
    const provider = new PrexRegistryProvider(
      new RegistryClient({ baseUrl: BASE, transport }),
    );
    const record = await provider.fetchArtifactRecord(
      'pkg:npm/demo-tool@1.2.3',
    );
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
