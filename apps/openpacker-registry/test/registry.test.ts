import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { canonicalDigest, formatDigest } from '@openpacker/canonical';
import { Ed25519Signer } from '@openpacker/trust';
import { RegistryClient } from '@openpacker/registry-client';
import type { HttpRequest, HttpResponse } from '@openpacker/adapter-core';
import type { JsonValue, PackageManifest } from '@openpacker/contracts';
import { createRegistry, RegistryStore } from '../src/index.js';
import { runRegistry } from '../src/cli.js';

const keys = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('../../../fixtures/trust/keys.json', import.meta.url),
    ),
    'utf8',
  ),
) as Record<string, JsonWebKey>;

const BASE = 'https://registry.test';

it('keeps CLI validation runnable without starting a registry', async () => {
  let stdout = '';
  let stderr = '';
  const io = {
    stdout: { write: (text: string) => (stdout += text) },
    stderr: { write: (text: string) => (stderr += text) },
  };
  await expect(runRegistry(['--help'], io)).resolves.toBe(0);
  await expect(runRegistry([], io)).resolves.toBe(2);
  expect(stdout).toContain('--registry-id');
  expect(stderr).toContain('--registry-id is required');
});

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
  };
}

async function signedStatus(
  name: string,
  version: string,
  status: 'active' | 'deprecated' | 'deleted',
  options: {
    eventId?: string;
    issuedAt?: string;
    keyId?: string;
    key?: JsonWebKey;
  } = {},
) {
  const update = {
    statusUpdateVersion: '1' as const,
    eventId: options.eventId ?? `${name}@${version}:${status}`,
    name,
    version,
    status,
    reason: `test transition to ${status}`,
    issuedAt: options.issuedAt ?? '2026-08-10T00:00:00.000Z',
  };
  const updateDigest = await canonicalDigest(update as unknown as JsonValue);
  const keyId = options.keyId ?? 'publisher-1';
  const signer = await Ed25519Signer.fromJwk(keyId, options.key ?? keys.leaf!);
  return {
    update,
    updateDigest,
    signatures: [
      {
        algorithm: 'ed25519' as const,
        keyId,
        signature: await signer.sign(
          new TextEncoder().encode(formatDigest(updateDigest)),
        ),
        role: 'publisher' as const,
      },
    ],
  };
}

function registry(
  overrides: Record<string, unknown> = {},
  bindPublisher = true,
) {
  const store =
    (overrides.store as RegistryStore | undefined) ?? new RegistryStore();
  if (bindPublisher)
    store.trustKey(
      'com.example',
      'publisher-1',
      'registry-configured',
      '2026-08-10T00:00:00.000Z',
    );
  return createRegistry({
    registryId: 'urn:openpacker:registry:test',
    displayName: 'test registry',
    purlTypes: ['npm'],
    store,
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
    expect(types).not.toContain('prex.registry.key-lifecycle/1');
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
        namespaceProof: {
          namespace: 'com.attacker',
          method: 'dns-txt',
          keyId: 'publisher-1',
        },
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().detail).toMatch(/additional properties/u);
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
    const app = registry({}, false);
    const body = await signed(manifest());
    const selfAuthorized = await app.inject({
      method: 'POST',
      url: '/v1/publish',
      payload: {
        ...body,
        namespaceProof: {
          namespace: 'com.example',
          method: 'dns-txt',
          keyId: 'publisher-1',
        },
      },
    });
    expect(selfAuthorized.statusCode).toBe(400);
    // A valid signature on a name this key was never bound to is a valid
    // signature on a squatted name. The refused proof above must not persist.
    const response = await app.inject({
      method: 'POST',
      url: '/v1/publish',
      payload: body,
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

    const client = clientFor(app, {
      keys: { 'publisher-1': keys.leaf!, 'test-registry': keys.root! },
      clock: () => Date.parse('2026-08-10T00:00:00.000Z'),
    });
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
      payload: await signedStatus('com.example.demo', '1.2.3', 'deleted'),
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

  it('requires a fresh namespace signature and rejects lifecycle replays', async () => {
    const app = registry({
      publisherKeys: {
        'publisher-1': keys.leaf!,
        'publisher-2': keys.log!,
      },
    });
    await app.inject({
      method: 'POST',
      url: '/v1/publish',
      payload: await signed(manifest()),
    });
    const route = '/v1/packages/com.example.demo/versions/1.2.3/status';

    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: route,
          payload: { status: 'deleted' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: route,
          payload: await signedStatus('com.example.demo', '1.2.3', 'deleted', {
            eventId: 'wrong-namespace',
            keyId: 'publisher-2',
            key: keys.log!,
          }),
        })
      ).statusCode,
    ).toBe(403);
    const mismatched = await signedStatus(
      'com.example.demo',
      '1.2.3',
      'deleted',
      { eventId: 'digest-mismatch' },
    );
    mismatched.update.reason = 'changed after signing';
    expect(
      (await app.inject({ method: 'PATCH', url: route, payload: mismatched }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: route,
          payload: await signedStatus('com.example.demo', '1.2.3', 'deleted', {
            eventId: 'stale',
            issuedAt: '2026-08-09T23:54:59.000Z',
          }),
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/v1/packages/com.example.demo/versions/1.2.3',
        })
      ).json().registryMetadata.status,
    ).toBe('active');

    const accepted = await signedStatus(
      'com.example.demo',
      '1.2.3',
      'deleted',
      { eventId: 'accepted-delete' },
    );
    expect(
      (await app.inject({ method: 'PATCH', url: route, payload: accepted }))
        .statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: 'PATCH', url: route, payload: accepted }))
        .statusCode,
    ).toBe(409);
    await app.close();
  });

  it('rejects lifecycle rollback while scoping event ids to each package', async () => {
    const store = new RegistryStore();
    store.trustKey('com.example', 'publisher-1', 'registry-configured');
    store.trustKey('org.other', 'publisher-2', 'registry-configured');
    const app = registry({
      store,
      clock: { now: () => '2026-08-10T00:02:00.000Z' },
      publisherKeys: {
        'publisher-1': keys.leaf!,
        'publisher-2': keys.log!,
      },
    });
    await app.inject({
      method: 'POST',
      url: '/v1/publish',
      payload: await signed(manifest()),
    });
    await app.inject({
      method: 'POST',
      url: '/v1/publish',
      payload: await signedWith(
        'publisher-2',
        keys.log!,
        manifest('org.other.demo', '1.0.0'),
      ),
    });
    const firstRoute = '/v1/packages/com.example.demo/versions/1.2.3/status';
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: firstRoute,
          payload: await signedStatus('com.example.demo', '1.2.3', 'deleted', {
            eventId: 'shared-event',
            issuedAt: '2026-08-10T00:01:00.000Z',
          }),
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: firstRoute,
          payload: await signedStatus('com.example.demo', '1.2.3', 'active', {
            eventId: 'older-event',
            issuedAt: '2026-08-10T00:00:30.000Z',
          }),
        })
      ).statusCode,
    ).toBe(409);
    const other = await app.inject({
      method: 'PATCH',
      url: '/v1/packages/org.other.demo/versions/1.0.0/status',
      payload: await signedStatus('org.other.demo', '1.0.0', 'deprecated', {
        eventId: 'shared-event',
        issuedAt: '2026-08-10T00:01:00.000Z',
        keyId: 'publisher-2',
        key: keys.log!,
      }),
    });
    expect(other.statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: firstRoute.replace('/status', ''),
        })
      ).json().registryMetadata.status,
    ).toBe('deleted');
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

  it('drops digest-inconsistent search results and marks the source unavailable', async () => {
    const up = await upstream();
    const local = registry({
      store: new RegistryStore(),
      sources: [{ id: 'corrupt', spec: { kind: 'prex', url: BASE } }],
      registryClientFactory: () =>
        new RegistryClient({
          baseUrl: BASE,
          transport: {
            async request(request: HttpRequest): Promise<HttpResponse> {
              const response = await up.inject({
                method: 'GET',
                url: request.url.replace(BASE, ''),
              });
              const body = response.json();
              if (request.url.includes('/v1/packages?'))
                body.packages[0].registryMetadata.manifestDigest.value =
                  'f'.repeat(64);
              return {
                status: response.statusCode,
                headers: response.headers as Record<string, string>,
                body: new TextEncoder().encode(JSON.stringify(body)),
                url: request.url,
              };
            },
          },
        }),
    });
    const response = await local.inject({
      method: 'GET',
      url: '/v1/packages?search=upstream-only',
    });
    expect(response.json().packages).toEqual([]);
    expect(response.json().metadata.unavailable).toEqual([
      { sourceId: 'corrupt', reason: expect.stringMatching(/hashes to/u) },
    ]);
    await up.close();
    await local.close();
  });
});

describe('serviceability through the registry', () => {
  /** Count probes so "a read triggered a check" is observable. */
  function probing(status = 200) {
    const probes: string[] = [];
    return {
      probes,
      transport: {
        async request(request: HttpRequest): Promise<HttpResponse> {
          probes.push(request.url);
          return {
            status,
            headers: {},
            body: new Uint8Array(),
            url: request.url,
          } as HttpResponse;
        },
      },
    };
  }

  /** Let the fire-and-forget check settle before asserting. */
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  it('does not derive egress authority from publisher locations', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const app = registry();
    try {
      await app.inject({
        method: 'POST',
        url: '/v1/publish',
        payload: await signed(manifest()),
      });
      await app.inject({
        method: 'GET',
        url: '/v1/packages/com.example.demo/versions/1.2.3',
      });
      await settle();
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      await app.close();
    }
  });

  it('checks what a manifest advertises because someone asked for it', async () => {
    const { probes, transport } = probing();
    const app = registry({ serviceabilityTransport: transport });
    await app.inject({
      method: 'POST',
      url: '/v1/publish',
      payload: await signed(manifest()),
    });

    // Nothing has been checked yet, so the first read says so rather than
    // implying it was fine.
    const first = await app.inject({
      method: 'GET',
      url: '/v1/packages/com.example.demo/versions/1.2.3',
    });
    expect(first.json().registryMetadata.serviceability).toBeUndefined();
    await settle();

    expect(probes).toEqual([
      'https://registry.npmjs.org/demo/-/demo-1.2.3.tgz',
    ]);
    const second = await app.inject({
      method: 'GET',
      url: '/v1/packages/com.example.demo/versions/1.2.3',
    });
    expect(second.json().registryMetadata.serviceability.state).toBe(
      'verified',
    );
    await app.close();
  });

  it('does not re-probe while the record is fresh', async () => {
    const { probes, transport } = probing();
    const app = registry({ serviceabilityTransport: transport });
    await app.inject({
      method: 'POST',
      url: '/v1/publish',
      payload: await signed(manifest()),
    });
    for (let index = 0; index < 5; index += 1) {
      await app.inject({
        method: 'GET',
        url: '/v1/packages/com.example.demo/versions/1.2.3',
      });
      await settle();
    }
    // Five readers must not become five requests to somebody else's origin.
    expect(probes).toHaveLength(1);
    await app.close();
  });

  it('never blocks the read on an origin it does not control', async () => {
    const app = registry({
      serviceabilityTransport: {
        async request(): Promise<HttpResponse> {
          await new Promise((resolve) => setTimeout(resolve, 60));
          throw new Error('slow origin');
        },
      },
    });
    await app.inject({
      method: 'POST',
      url: '/v1/publish',
      payload: await signed(manifest()),
    });
    const started = Date.now();
    const response = await app.inject({
      method: 'GET',
      url: '/v1/packages/com.example.demo/versions/1.2.3',
    });
    // This registry's latency must not be a function of every publisher's.
    expect(response.statusCode).toBe(200);
    expect(Date.now() - started).toBeLessThan(60);
    await app.close();
  });

  it('lets a report bring the next check forward, and nothing more', async () => {
    const { probes, transport } = probing();
    const app = registry({ serviceabilityTransport: transport });
    await app.inject({
      method: 'POST',
      url: '/v1/publish',
      payload: await signed(manifest()),
    });
    await app.inject({
      method: 'GET',
      url: '/v1/packages/com.example.demo/versions/1.2.3',
    });
    await settle();

    const reported = await app.inject({
      method: 'POST',
      url: '/v1/packages/com.example.demo/versions/1.2.3/observations',
      payload: { state: 'unreachable' },
    });
    expect(reported.statusCode).toBe(202);

    // The report did not set state — otherwise "report a competitor
    // unreachable" is a feature of the registry.
    const after = await app.inject({
      method: 'GET',
      url: '/v1/packages/com.example.demo/versions/1.2.3',
    });
    expect(after.json().registryMetadata.serviceability.state).toBe('verified');
    await settle();
    // It did bring the first-party check forward.
    expect(probes).toHaveLength(2);
    await app.close();
  });

  it('refuses an observation for something it does not serve', async () => {
    const app = registry();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/packages/com.example.nothing/versions/1.0.0/observations',
      payload: {},
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });
});

describe('key lifecycle', () => {
  /** A registry that signs, so its revocation list is verifiable. */
  async function signing() {
    const signer = await Ed25519Signer.fromJwk('test-registry', keys.root!);
    return registry({ signer, store: new RegistryStore() });
  }

  it('serves a signed revocation list even when nothing is revoked', async () => {
    const app = await signing();
    const response = await app.inject({
      method: 'GET',
      url: '/v1/revocations',
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    // Empty-and-signed is a different claim from absent: it says this registry
    // does revocation and currently revokes nothing.
    expect(body.list.revoked).toEqual([]);
    expect(body.signatures).toHaveLength(1);
    expect(body.signatures[0].role).toBe('registry');
    await app.close();
  });

  it('advertises key-lifecycle so a client knows revocation exists here', async () => {
    const app = await signing();
    const response = await app.inject({
      method: 'GET',
      url: '/.well-known/prex-registry',
    });
    expect(response.json().resources[0]['@type']).toContain(
      'prex.registry.key-lifecycle/1',
    );
    await app.close();
  });

  it('rotates a key, keeping what it already signed verifiable', async () => {
    const app = await signing();
    await app.inject({
      method: 'POST',
      url: '/v1/publish',
      payload: await signed(manifest()),
    });

    // Rotate publisher-1 to a successor it attests.
    const rotation = await rotationTo('publisher-2', keys.log!);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/keys/rotations',
      payload: rotation,
    });
    expect(response.statusCode).toBe(201);

    const list = (
      await app.inject({ method: 'GET', url: '/v1/revocations' })
    ).json();
    const entry = list.list.revoked[0];
    // from-now, not retroactive: a routine rotation that disowned every past
    // signature would break every lockfile pinning something this key signed.
    expect(entry.keyId).toBe('publisher-1');
    expect(entry.effective).toBe('from-now');
    expect(entry.replacedBy).toBe('publisher-2');
    await app.close();
  });

  it('refuses a rotation not attested by the key it claims to succeed', async () => {
    const app = await signing();
    const rotation = await rotationTo('publisher-2', keys.log!);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/keys/rotations',
      // Anyone could otherwise nominate a successor to someone else's key.
      payload: { ...rotation, signature: 'AAAAAAAAAAAAAAAAAAAAAA==' },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it('stops a revoked key publishing, both effects', async () => {
    const app = await signing();
    await app.inject({
      method: 'POST',
      url: '/v1/keys/rotations',
      payload: await rotationTo('publisher-2', keys.log!),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/publish',
      payload: await signed(manifest('com.example.after', '1.0.0')),
    });
    // Retiring a key means it stops being used going forward; only whether its
    // past work still counts depends on the effect.
    expect(response.statusCode).toBe(403);
    expect(response.json().detail).toMatch(/revoked/);
    await app.close();
  });

  it('lets the successor key publish', async () => {
    const app = await signing();
    await app.inject({
      method: 'POST',
      url: '/v1/keys/rotations',
      payload: await rotationTo('publisher-2', keys.log!),
    });
    // The successor is usable without an operator round-trip, or nobody rotates.
    const body = await signedWith('publisher-2', keys.log!, manifest());
    const response = await app.inject({
      method: 'POST',
      url: '/v1/publish',
      payload: body,
    });
    expect(response.statusCode).toBe(201);
    await app.close();
  });

  it('does not let a revoked successor rotate authority again', async () => {
    const app = await signing();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/keys/rotations',
          payload: await rotationFrom(
            'publisher-1',
            keys.leaf!,
            'publisher-2',
            keys.log!,
            '2026-08-10T00:01:00.000Z',
          ),
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/keys/rotations',
          payload: await rotationFrom(
            'publisher-2',
            keys.log!,
            'publisher-3',
            keys.root!,
            '2026-08-10T00:02:00.000Z',
          ),
        })
      ).statusCode,
    ).toBe(201);
    const rejected = await app.inject({
      method: 'POST',
      url: '/v1/keys/rotations',
      payload: await rotationFrom(
        'publisher-2',
        keys.log!,
        'attacker',
        keys.leaf!,
        '2026-08-10T00:03:00.000Z',
      ),
    });
    expect(rejected.statusCode).toBe(403);
    expect(rejected.json().detail).toMatch(/revoked/u);
    await app.close();
  });
});

/** A rotation from publisher-1 to `nextKeyId`, signed by publisher-1. */
async function rotationTo(nextKeyId: string, nextJwk: JsonWebKey) {
  return rotationFrom(
    'publisher-1',
    keys.leaf!,
    nextKeyId,
    nextJwk,
    '2026-08-11T00:00:00.000Z',
  );
}

async function rotationFrom(
  previousKeyId: string,
  previousJwk: JsonWebKey,
  nextKeyId: string,
  nextJwk: JsonWebKey,
  rotatedAt: string,
) {
  const { rotationMessage } = await import('../src/keys.js');
  const unsigned = {
    previousKeyId,
    nextKeyId,
    nextPublicKey: { kty: 'OKP', crv: 'Ed25519', x: nextJwk.x! },
    rotatedAt,
  };
  const signer = await Ed25519Signer.fromJwk(previousKeyId, previousJwk);
  return {
    ...unsigned,
    signature: await signer.sign(await rotationMessage(unsigned)),
  };
}

/** Sign a manifest with an arbitrary key id and JWK. */
async function signedWith(
  keyId: string,
  jwk: JsonWebKey,
  value: PackageManifest,
) {
  const digest = await canonicalDigest(value as unknown as JsonValue);
  const signer = await Ed25519Signer.fromJwk(keyId, jwk);
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
  };
}
