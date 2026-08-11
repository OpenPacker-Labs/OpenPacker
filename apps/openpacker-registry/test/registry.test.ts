import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { canonicalDigest, formatDigest } from '@openpacker/canonical';
import { Ed25519Signer } from '@openpacker/trust';
import { RegistryClient } from '@openpacker/registry-client';
import type { HttpRequest, HttpResponse } from '@openpacker/adapter-core';
import type { JsonValue, PackageManifest } from '@openpacker/contracts';
import { createRegistry, RegistryStore } from '../src/index.js';

const keys = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('../../../fixtures/trust/keys.json', import.meta.url),
    ),
    'utf8',
  ),
) as Record<string, JsonWebKey>;

const BASE = 'https://registry.test';

function manifest(
  name = 'com.example.demo',
  version = '1.2.3',
): PackageManifest {
  return {
    packageManifestVersion: '1',
    name,
    version,
    distributions: [
      {
        purlType: 'npm',
        identifier: 'demo',
        version,
        exactPurl: `pkg:npm/demo@${version}`,
        digest: { algorithm: 'sha256', value: '3'.repeat(64) },
        size: 10,
        mediaType: 'application/vnd.npm.install-v1+json',
        locations: [`https://registry.npmjs.org/demo/-/demo-${version}.tgz`],
      },
    ],
  } as PackageManifest;
}

async function signed(value: PackageManifest, keyId = 'publisher-1') {
  const digest = await canonicalDigest(value as unknown as JsonValue);
  const signer = await Ed25519Signer.fromJwk(keyId, keys.leaf!);
  return {
    manifest: value,
    manifestDigest: digest,
    signatures: [
      {
        algorithm: 'ed25519' as const,
        keyId,
        signature: await signer.sign(
          new TextEncoder().encode(formatDigest(digest)),
        ),
        role: 'publisher' as const,
      },
    ],
    namespaceProof: {
      namespace: 'com.example',
      method: 'registry-configured' as const,
      keyId,
    },
  };
}

function registry(overrides: Record<string, unknown> = {}) {
  return createRegistry({
    registryId: 'urn:openpacker:registry:test',
    displayName: 'test registry',
    purlTypes: ['npm'],
    store: new RegistryStore(),
    publisherKeys: { 'publisher-1': keys.leaf! },
    clock: { now: () => '2026-08-10T00:00:00.000Z' },
    ...overrides,
  });
}

/** Drive the real client against an in-process instance via app.inject. */
function clientFor(app: ReturnType<typeof registry>, keyOverrides = {}) {
  const transport = {
    async request(request: HttpRequest): Promise<HttpResponse> {
      const response = await app.inject({
        method: (request.method ?? 'GET') as 'GET',
        url: request.url.replace(BASE, ''),
      });
      return {
        status: response.statusCode,
        headers: response.headers as Record<string, string>,
        body: new Uint8Array(response.rawPayload),
        url: request.url,
      } as HttpResponse;
    },
  };
  return new RegistryClient({ baseUrl: BASE, transport, ...keyOverrides });
}

describe('service index', () => {
  it('advertises what it serves, and does not claim bytes', async () => {
    const app = registry();
    const response = await app.inject({
      method: 'GET',
      url: '/.well-known/prex-registry',
    });
    expect(response.statusCode).toBe(200);
    const types = response.json().resources[0]['@type'] as string[];
    expect(types).toContain('prex.registry.package-manifest/1');
    expect(types).toContain('prex.registry.sync/1');
    // Advertising artifact/1 would promise bytes this registry does not hold.
    expect(types).not.toContain('prex.registry.artifact/1');
    await app.close();
  });
});

describe('publish', () => {
  it('stores a signed manifest and counter-signs it', async () => {
    const signer = await Ed25519Signer.fromJwk('test-registry', keys.root!);
    const app = registry({ signer });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/publish',
      payload: await signed(manifest()),
    });
    expect(response.statusCode).toBe(201);
    const roles = response
      .json()
      .entry.signatures.map((s: { role: string }) => s.role);
    // "I wrote this" and "I accepted this" are different claims.
    expect(roles).toEqual(['publisher', 'registry']);
    await app.close();
  });

  it('refuses an unsigned manifest unless the operator opted in', async () => {
    const app = registry();
    const unsigned = {
      manifest: manifest(),
      manifestDigest: await canonicalDigest(manifest() as unknown as JsonValue),
    };
    const closed = await app.inject({
      method: 'POST',
      url: '/v1/publish',
      payload: unsigned,
    });
    expect(closed.statusCode).toBe(401);
    await app.close();

    const open = registry({ anonymousPublish: true });
    const allowed = await open.inject({
      method: 'POST',
      url: '/v1/publish',
      payload: unsigned,
    });
    expect(allowed.statusCode).toBe(201);
    await open.close();
  });

  it('refuses a manifest that does not validate, storing nothing', async () => {
    const app = registry({ anonymousPublish: true });
    // MCP issue #783: a registry that stores what it cannot honour moves the
    // cost onto every client, which meets the document at install time with no
    // way to refuse.
    const broken = await signed(manifest());
    (broken as unknown as { manifest: unknown }).manifest = {
      ...manifest(),
      distributions: 'oops',
    };
    const response = await app.inject({
      method: 'POST',
      url: '/v1/publish',
      payload: broken,
    });
    expect(response.statusCode).toBe(400);
    // The reported path is what a publisher acts on.
    expect(response.json().detail).toMatch(/\/manifest\/distributions/);

    // Nothing was stored, so a reader never meets it.
    const read = await app.inject({
      method: 'GET',
      url: '/v1/packages/com.example.demo/versions/1.2.3',
    });
    expect(read.statusCode).toBe(404);
    await app.close();
  });

  it('refuses a version that names no particular release', async () => {
    const app = registry({ anonymousPublish: true });
    // Sign the document actually being sent, so this isolates the schema
    // refusal rather than passing on a digest mismatch.
    const body = await signed({
      ...manifest(),
      version: 'latest',
    } as PackageManifest);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/publish',
      payload: body,
    });
    // `latest` moves, so a manifest naming it describes no particular thing
    // and could not be pinned or verified.
    expect(response.statusCode).toBe(400);
    expect(response.json().detail).toMatch(/not a publishable document/);
    await app.close();
  });

  it('refuses a malformed envelope around a valid manifest', async () => {
    const app = registry({ anonymousPublish: true });
    const body = await signed(manifest());
    const response = await app.inject({
      method: 'POST',
      url: '/v1/publish',
      payload: {
        ...body,
        // A well-formed manifest inside a request this registry cannot act on
        // is still a request it cannot act on.
        namespaceProof: { namespace: 'Example', method: 'dns-txt', keyId: 'k' },
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().detail).toMatch(/\/namespaceProof\/namespace/);
    await app.close();
  });

  it('refuses a digest the manifest does not hash to', async () => {
    const app = registry();
    const body = await signed(manifest());
    const response = await app.inject({
      method: 'POST',
      url: '/v1/publish',
      payload: {
        ...body,
        manifestDigest: { algorithm: 'sha256', value: 'f'.repeat(64) },
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('DIGEST_MISMATCH');
    await app.close();
  });

  it('refuses a signature that does not verify', async () => {
    const app = registry();
    const body = await signed(manifest());
    const response = await app.inject({
      method: 'POST',
      url: '/v1/publish',
      payload: {
        ...body,
        signatures: [
          { ...body.signatures[0]!, signature: 'AAAAAAAAAAAAAAAAAAAAAA==' },
        ],
      },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it('refuses a key with no claim to the name', async () => {
    const app = registry();
    const body = await signed(manifest());
    // A valid signature on a name this key was never bound to is a valid
    // signature on a squatted name.
    const response = await app.inject({
      method: 'POST',
      url: '/v1/publish',
      payload: { ...body, namespaceProof: undefined },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe('POLICY_DENIED');
    await app.close();
  });

  it('is idempotent for the same bytes and a conflict for different ones', async () => {
    const app = registry();
    const body = await signed(manifest());
    expect(
      (await app.inject({ method: 'POST', url: '/v1/publish', payload: body }))
        .statusCode,
    ).toBe(201);
    // A retry must not be a conflict.
    expect(
      (await app.inject({ method: 'POST', url: '/v1/publish', payload: body }))
        .statusCode,
    ).toBe(200);

    const changed = await signed({
      ...manifest(),
      description: 'different bytes, same version',
    } as PackageManifest);
    const conflict = await app.inject({
      method: 'POST',
      url: '/v1/publish',
      payload: changed,
    });
    // Republishing 1.2.3 with new contents changes a pinned build underneath
    // whoever pinned it.
    expect(conflict.statusCode).toBe(409);
    await app.close();
  });
});

describe('reading, through the real client', () => {
  it('round-trips publish then read', async () => {
    const signer = await Ed25519Signer.fromJwk('test-registry', keys.root!);
    const app = registry({ signer });
    await app.inject({
      method: 'POST',
      url: '/v1/publish',
      payload: await signed(manifest()),
    });

    const client = clientFor(app, { keys: { 'publisher-1': keys.leaf! } });
    const entry = await client.entry('com.example.demo', '1.2.3');
    expect(entry.manifest.version).toBe('1.2.3');
    // The wire contract is exercised by a real consumer, not asserted.
    const verification = await client.verifyEntry(entry);
    expect(verification.digestMatches).toBe(true);
    expect(
      verification.signatures.find((s) => s.keyId === 'publisher-1')?.status,
    ).toBe('valid');
    await app.close();
  });

  it('resolves the latest alias', async () => {
    const app = registry();
    for (const version of ['1.0.0', '1.1.0'])
      await app.inject({
        method: 'POST',
        url: '/v1/publish',
        payload: await signed(manifest('com.example.demo', version)),
      });
    const client = clientFor(app);
    expect(
      (await client.entry('com.example.demo', 'latest')).manifest.version,
    ).toBe('1.1.0');
    await app.close();
  });

  it('keeps a withdrawn version retrievable but out of listings', async () => {
    const app = registry();
    await app.inject({
      method: 'POST',
      url: '/v1/publish',
      payload: await signed(manifest()),
    });
    await app.inject({
      method: 'PATCH',
      url: '/v1/packages/com.example.demo/versions/1.2.3/status',
      payload: { status: 'deleted' },
    });

    const client = clientFor(app);
    // A consumer holding a lockfile has to be able to learn it was withdrawn;
    // a 404 tells it nothing.
    const entry = await client.entry('com.example.demo', '1.2.3');
    expect(entry.registryMetadata.status).toBe('deleted');
    const page = await client.list({});
    expect(page.packages).toHaveLength(0);
    await app.close();
  });

  it('pages a cursor walk over every record exactly once', async () => {
    const app = registry();
    for (let index = 0; index < 7; index += 1)
      await app.inject({
        method: 'POST',
        url: '/v1/publish',
        payload: await signed(manifest(`com.example.p${index}`, '1.0.0')),
      });

    const client = clientFor(app);
    const seen: string[] = [];
    for await (const entry of client.listAll({ limit: 3 }))
      seen.push(entry.manifest.name);
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
    await app.close();
  });

  it('syncs only what changed since a watermark', async () => {
    let now = '2026-08-10T00:00:00.000Z';
    const app = registry({ clock: { now: () => now } });
    await app.inject({
      method: 'POST',
      url: '/v1/publish',
      payload: await signed(manifest('com.example.first', '1.0.0')),
    });
    now = '2026-08-11T00:00:00.000Z';
    await app.inject({
      method: 'POST',
      url: '/v1/publish',
      payload: await signed(manifest('com.example.second', '1.0.0')),
    });

    const client = clientFor(app);
    const names: string[] = [];
    for await (const entry of client.listAll({
      updatedSince: '2026-08-10T12:00:00.000Z',
    }))
      names.push(entry.manifest.name);
    expect(names).toEqual(['com.example.second']);
    await app.close();
  });

  it('rejects a malformed cursor rather than starting over', async () => {
    const app = registry();
    const response = await app.inject({
      method: 'GET',
      url: '/v1/packages?cursor=not-a-cursor',
    });
    // Silently restarting would make a mirror re-read everything and think it
    // had caught up.
    expect(response.statusCode).toBe(400);
    await app.close();
  });
});

describe('federation over external sources', () => {
  /** An upstream registry holding something the local one does not. */
  async function upstream(name = 'com.example.upstream-only') {
    const app = registry({
      registryId: 'urn:openpacker:registry:upstream',
      store: new RegistryStore(),
    });
    await app.inject({
      method: 'POST',
      url: '/v1/publish',
      payload: await signed(manifest(name, '2.0.0')),
    });
    return app;
  }

  /** A local registry fronting that upstream, wired in-process. */
  function fronting(up: ReturnType<typeof registry>) {
    return registry({
      store: new RegistryStore(),
      sources: [
        { id: 'published', spec: { kind: 'published' } },
        { id: 'upstream', spec: { kind: 'prex', url: BASE } },
      ],
      registryClientFactory: () => clientFor(up),
    });
  }

  it('relays a package it does not hold, tagged with its source', async () => {
    const up = await upstream();
    const local = fronting(up);
    const response = await local.inject({
      method: 'GET',
      url: '/v1/packages/com.example.upstream-only/versions/2.0.0',
    });
    expect(response.statusCode).toBe(200);
    const metadata = response.json().registryMetadata;
    // The registry answering says so, and records that it is relaying — the
    // difference between what it holds and what it fronts.
    expect(metadata.registryId).toBe('urn:openpacker:registry:test');
    expect(metadata.sourceId).toBe('upstream');
    await up.close();
    await local.close();
  });

  it('carries upstream signatures through rather than re-signing', async () => {
    const up = await upstream();
    const local = fronting(up);
    const response = await local.inject({
      method: 'GET',
      url: '/v1/packages/com.example.upstream-only/versions/2.0.0',
    });
    // Re-signing would make a relay indistinguishable from an original, and
    // the upstream's key is the one a consumer wants to check.
    expect(
      response.json().signatures.map((s: { keyId: string }) => s.keyId),
    ).toEqual(['publisher-1']);
    await up.close();
    await local.close();
  });

  it('lets what the registry publishes win over an upstream of the same name', async () => {
    const up = await upstream('com.example.demo');
    const local = fronting(up);
    await local.inject({
      method: 'POST',
      url: '/v1/publish',
      payload: await signed(manifest('com.example.demo', '2.0.0')),
    });
    const response = await local.inject({
      method: 'GET',
      url: '/v1/packages/com.example.demo/versions/2.0.0',
    });
    // An upstream publishing a name you already publish must not take it over.
    expect(response.json().registryMetadata.sourceId).toBeUndefined();
    await up.close();
    await local.close();
  });

  it('still 404s for something no source holds', async () => {
    const up = await upstream();
    const local = fronting(up);
    const response = await local.inject({
      method: 'GET',
      url: '/v1/packages/com.example.nowhere/versions/1.0.0',
    });
    expect(response.statusCode).toBe(404);
    await up.close();
    await local.close();
  });

  it('names a source that did not answer rather than reporting no results', async () => {
    const local = registry({
      store: new RegistryStore(),
      sources: [{ id: 'down', spec: { kind: 'prex', url: BASE } }],
      registryClientFactory: () =>
        new RegistryClient({
          baseUrl: BASE,
          transport: {
            async request() {
              throw new Error('connect ECONNREFUSED');
            },
          },
        }),
    });
    const response = await local.inject({
      method: 'GET',
      url: '/v1/packages?search=anything',
    });
    expect(response.statusCode).toBe(200);
    // "No results" and "a source was down" must not read the same to a mirror.
    expect(response.json().metadata.unavailable).toEqual([
      { sourceId: 'down', reason: expect.stringContaining('ECONNREFUSED') },
    ]);
    await local.close();
  });

  it('merges an upstream search result the local store did not have', async () => {
    const up = await upstream();
    const local = fronting(up);
    const response = await local.inject({
      method: 'GET',
      url: '/v1/packages?search=upstream-only',
    });
    const names = response
      .json()
      .packages.map(
        (entry: { manifest: { name: string } }) => entry.manifest.name,
      );
    expect(names).toEqual(['com.example.upstream-only']);
    await up.close();
    await local.close();
  });
});
