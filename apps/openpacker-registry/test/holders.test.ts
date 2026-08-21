import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { canonicalDigest, formatDigest } from '@openpacker/canonical';
import { Ed25519Signer } from '@openpacker/trust';
import type { JsonValue, PackageManifest } from '@openpacker/contracts';
import { createRegistry, RegistryStore } from '../src/index.js';
import {
  holderOf,
  quotaState,
  redirectMessage,
  resolveRedirect,
  retryAfterSeconds,
  type PackageRedirect,
} from '../src/holders.js';

// SAFETY: The surrounding boundary establishes the asserted domain contract.
const keys = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('../../../fixtures/trust/keys.json', import.meta.url),
    ),
    'utf8',
  ),
) as Record<string, JsonWebKey>;

function manifest(name: string, version = '1.0.0'): PackageManifest {
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
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

async function publishBody(
  name: string,
  version: string,
  _namespace: string,
  keyId = 'publisher-1',
) {
  const value = manifest(name, version);
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
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

function registry(
  overrides: Record<string, unknown> = {},
  namespaces: readonly string[] = ['com.example'],
) {
  const store =
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    (overrides.store as RegistryStore | undefined) ?? new RegistryStore();
  for (const namespace of namespaces)
    store.trustKey(
      namespace,
      'publisher-1',
      'dns-txt',
      '2026-08-10T00:00:00.000Z',
      namespace.startsWith('org.other') ? 'dns:other.org' : 'dns:example.com',
    );
  return createRegistry({
    registryId: 'urn:openpacker:registry:test',
    purlTypes: ['npm'],
    store,
    publisherKeys: { 'publisher-1': keys.leaf!, 'publisher-2': keys.leaf! },
    clock: { now: () => '2026-08-10T00:00:00.000Z' },
    ...overrides,
  });
}

describe('holder attribution', () => {
  it('attributes every namespace under one domain to one holder', () => {
    // The MCP survey found one domain behind 75 namespaces. Per-proof records
    // make that invisible; per-holder records make it a lookup.
    expect(holderOf('com.example.tools', 'dns-txt', 'dns:example.com')).toBe(
      'dns:example.com',
    );
    expect(holderOf('com.example.cli', 'dns-txt', 'dns:example.com')).toBe(
      'dns:example.com',
    );
    expect(holderOf('com.example', 'https-well-known', 'dns:example.com')).toBe(
      'dns:example.com',
    );
  });

  it('stops a forge namespace at the account, not the forge', () => {
    // io.github.acme is not authority over io.github.someone-else — collapsing
    // them would let one account speak for every other on the same forge.
    expect(holderOf('io.github.acme.tool', 'dns-txt', 'github:acme')).toBe(
      'github:acme',
    );
    expect(holderOf('io.github.other.tool', 'dns-txt', 'github:other')).toBe(
      'github:other',
    );
  });

  it('refuses to guess a DNS holder without proof-verifier identity', () => {
    expect(() => holderOf('uk.co.alpha', 'dns-txt')).toThrow(/verified/u);
  });

  it('names an operator decision as one rather than dressing it as a proof', () => {
    expect(holderOf('com.example.tool', 'registry-configured')).toBe(
      'operator:com.example.tool',
    );
  });

  it('reports namespaces and package counts for a holder', async () => {
    const app = registry();
    await app.inject({
      method: 'POST',
      url: '/v1/publish',
      payload: await publishBody('com.example.one', '1.0.0', 'com.example'),
    });
    await app.inject({
      method: 'POST',
      url: '/v1/publish',
      payload: await publishBody('com.example.two', '1.0.0', 'com.example'),
    });
    const response = await app.inject({
      method: 'GET',
      url: '/v1/holders/dns%3Aexample.com',
    });
    expect(response.statusCode).toBe(200);
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const body = response.json() as {
      holderId: string;
      namespaces: { namespace: string; packageCount: number }[];
    };
    expect(body.holderId).toBe('dns:example.com');
    expect(body.namespaces[0]?.namespace).toBe('com.example');
    // Two names under one namespace, not two namespaces.
    expect(body.namespaces[0]?.packageCount).toBe(2);
  });

  it('lists the most concentrated holder first', async () => {
    const app = registry({}, ['com.example.a', 'com.example.b', 'org.other']);
    await app.inject({
      method: 'POST',
      url: '/v1/publish',
      payload: await publishBody('com.example.a', '1.0.0', 'com.example.a'),
    });
    await app.inject({
      method: 'POST',
      url: '/v1/publish',
      payload: await publishBody('com.example.b', '1.0.0', 'com.example.b'),
    });
    await app.inject({
      method: 'POST',
      url: '/v1/publish',
      payload: await publishBody('org.other.c', '1.0.0', 'org.other'),
    });
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const holders = (
      await app.inject({ method: 'GET', url: '/v1/holders' })
    ).json() as { holders: { holderId: string; namespaces: unknown[] }[] };
    // A list sorted by name buries the thing this route exists to surface.
    expect(holders.holders[0]?.holderId).toBe('dns:example.com');
    expect(holders.holders[0]?.namespaces).toHaveLength(2);
  });
});

describe('publish quota', () => {
  it('slides rather than bucketing, so a boundary is not a double allowance', () => {
    const policy = { limit: 2, windowSeconds: 60 };
    const now = 1_000_000;
    // Two publishes 59 seconds ago fill the window; a fixed bucket would have
    // reset at the top of the minute and allowed two more immediately.
    const state = quotaState([now - 59_000, now - 58_000], policy, now);
    expect(state.remaining).toBe(0);
    // Free again when the *oldest* ages out, not at some round number.
    expect(retryAfterSeconds(state, now)).toBe(1);
  });

  it('charges a holder once, however many namespaces it takes out', async () => {
    const app = registry({ quota: { limit: 2, windowSeconds: 3600 } }, [
      'com.example.a',
      'com.example.b',
      'com.example.c',
    ]);
    // Three different namespaces, one domain behind all of them. A per-namespace
    // budget would let this run forever for the price of a DNS record.
    const first = await app.inject({
      method: 'POST',
      url: '/v1/publish',
      payload: await publishBody('com.example.a', '1.0.0', 'com.example.a'),
    });
    const second = await app.inject({
      method: 'POST',
      url: '/v1/publish',
      payload: await publishBody('com.example.b', '1.0.0', 'com.example.b'),
    });
    const third = await app.inject({
      method: 'POST',
      url: '/v1/publish',
      payload: await publishBody('com.example.c', '1.0.0', 'com.example.c'),
    });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(third.statusCode).toBe(429);
    expect(third.json().code).toBe('RATE_LIMITED');
    expect(Number(third.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('isolates registrants beneath a multi-label public suffix', async () => {
    const store = new RegistryStore();
    store.trustKey(
      'uk.co.alpha',
      'publisher-1',
      'dns-txt',
      '2026-08-10T00:00:00.000Z',
      'dns:alpha.co.uk',
    );
    store.trustKey(
      'uk.co.alpha.tools',
      'publisher-1',
      'dns-txt',
      '2026-08-10T00:00:00.000Z',
      'dns:alpha.co.uk',
    );
    store.trustKey(
      'uk.co.beta',
      'publisher-2',
      'dns-txt',
      '2026-08-10T00:00:00.000Z',
      'dns:beta.co.uk',
    );
    const app = registry(
      { store, quota: { limit: 1, windowSeconds: 3600 } },
      [],
    );

    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/publish',
          payload: await publishBody(
            'uk.co.alpha.tools.one',
            '1.0.0',
            'uk.co.alpha.tools',
          ),
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/publish',
          payload: await publishBody('uk.co.alpha.two', '1.0.0', 'uk.co.alpha'),
        })
      ).statusCode,
    ).toBe(429);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/publish',
          payload: await publishBody(
            'uk.co.beta.one',
            '1.0.0',
            'uk.co.beta',
            'publisher-2',
          ),
        })
      ).statusCode,
    ).toBe(201);
    await app.close();
  });

  it('admits no more concurrent publishes than the holder quota', async () => {
    const store = new RegistryStore();
    const app = registry({ quota: { limit: 2, windowSeconds: 3600 }, store }, [
      'com.example',
    ]);
    const bodies = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        publishBody(`com.example.concurrent-${index}`, '1.0.0', 'com.example'),
      ),
    );
    const responses = await Promise.all(
      bodies.map((payload) =>
        app.inject({ method: 'POST', url: '/v1/publish', payload }),
      ),
    );
    expect(
      responses.filter((response) => response.statusCode === 201),
    ).toHaveLength(2);
    expect(
      responses.filter((response) => response.statusCode === 429),
    ).toHaveLength(4);
    expect(
      Array.from({ length: 6 }, (_, index) =>
        store.versions(`com.example.concurrent-${index}`),
      ).filter((versions) => versions.length > 0),
    ).toHaveLength(2);
    await app.close();
  });

  it('does not charge a retry of a publish it already stored', async () => {
    const app = registry({ quota: { limit: 2, windowSeconds: 3600 } });
    const body = await publishBody('com.example.a', '1.0.0', 'com.example');
    const first = await app.inject({
      method: 'POST',
      url: '/v1/publish',
      payload: body,
    });
    // Identical bytes: this is a retried request, not a second publish. A
    // client whose connection dropped must not lose allowance for asking again.
    const retry = await app.inject({
      method: 'POST',
      url: '/v1/publish',
      payload: body,
    });
    expect(first.statusCode).toBe(201);
    expect(retry.statusCode).toBe(200);
    const second = await app.inject({
      method: 'POST',
      url: '/v1/publish',
      payload: await publishBody('com.example.b', '1.0.0', 'com.example'),
    });
    expect(second.statusCode).toBe(201);
  });

  it('does not charge a publish under a name the key does not hold', async () => {
    const store = new RegistryStore();
    const app = registry(
      { quota: { limit: 1, windowSeconds: 3600 }, store },
      [],
    );
    // Otherwise anyone can exhaust a publisher's allowance by publishing
    // rubbish under their name and being refused for it.
    const refused = await app.inject({
      method: 'POST',
      url: '/v1/publish',
      payload: await publishBody('com.example.a', '1.0.0', 'com.example.a'),
    });
    expect(refused.statusCode).toBe(403);
    store.trustKey(
      'com.example.a',
      'publisher-1',
      'dns-txt',
      '2026-08-10T00:00:00.000Z',
      'dns:example.com',
    );
    const allowed = await app.inject({
      method: 'POST',
      url: '/v1/publish',
      payload: await publishBody('com.example.a', '1.0.0', 'com.example.a'),
    });
    expect(allowed.statusCode).toBe(201);
  });

  it('reports what is left against the holder', async () => {
    const app = registry({ quota: { limit: 5, windowSeconds: 3600 } });
    await app.inject({
      method: 'POST',
      url: '/v1/publish',
      payload: await publishBody('com.example.a', '1.0.0', 'com.example'),
    });
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const holder = (
      await app.inject({ method: 'GET', url: '/v1/holders/dns%3Aexample.com' })
    ).json() as { quota: { remaining: number; limit: number } };
    expect(holder.quota).toEqual({
      limit: 5,
      windowSeconds: 3600,
      remaining: 4,
    });
  });
});

describe('rename and transfer', () => {
  async function renameBody(
    from: string,
    to: string,
    keyId: string,
    reason: 'rename' | 'transfer' = 'rename',
  ) {
    const redirect: PackageRedirect = {
      redirectVersion: '1',
      from,
      to,
      effectiveAt: '2026-08-10T00:00:00.000Z',
      reason,
    };
    const signer = await Ed25519Signer.fromJwk(keyId, keys.leaf!);
    return {
      redirect,
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      redirectDigest: await canonicalDigest(redirect as unknown as JsonValue),
      signatures: [
        {
          algorithm: 'ed25519' as const,
          keyId,
          signature: await signer.sign(await redirectMessage(redirect)),
          role: 'publisher' as const,
        },
      ],
    };
  }

  /** A registry holding io.github.acme.tool with operator-established authority. */
  async function withPackage(destinationAuthorized = false) {
    const app = registry({}, [
      'io.github.acme',
      ...(destinationAuthorized ? ['com.acme'] : []),
    ]);
    await app.inject({
      method: 'POST',
      url: '/v1/publish',
      payload: await publishBody(
        'io.github.acme.tool',
        '1.0.0',
        'io.github.acme',
      ),
    });
    return app;
  }

  it('refuses a rename signed by a key holding only the old name', async () => {
    const app = await withPackage();
    // The destination is unproved: a key that holds only the source could
    // otherwise point everyone pinned to it at somebody else's package.
    const response = await app.inject({
      method: 'POST',
      url: '/v1/packages/io.github.acme.tool/rename',
      payload: await renameBody(
        'io.github.acme.tool',
        'com.acme.tool',
        'publisher-1',
      ),
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().detail).toContain('both');
  });

  it('moves the package and leaves a verifiable redirect', async () => {
    const app = await withPackage(true);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/packages/io.github.acme.tool/rename',
      payload: await renameBody(
        'io.github.acme.tool',
        'com.acme.tool',
        'publisher-1',
      ),
    });
    expect(response.statusCode).toBe(201);

    // The old name keeps resolving, which is the entire point: a lockfile
    // pinning it must not stop working because its publisher moved.
    const old = await app.inject({
      method: 'GET',
      url: '/v1/packages/io.github.acme.tool/versions/1.0.0',
    });
    expect(old.statusCode).toBe(200);
    expect(old.headers['x-openpacker-renamed-from']).toBe(
      'io.github.acme.tool',
    );
    expect(old.json().manifest.name).toBe('io.github.acme.tool');

    // And the move itself is a document a mirror can check, rather than a
    // server-side redirect it would have to take on faith.
    const document = await app.inject({
      method: 'GET',
      url: '/v1/packages/io.github.acme.tool/redirect',
    });
    expect(document.statusCode).toBe(200);
    expect(document.json().redirect.to).toBe('com.acme.tool');
    expect(document.json().signatures).toHaveLength(1);
  });

  it('refuses to rename onto a name somebody already publishes', async () => {
    const app = await withPackage(true);
    await app.inject({
      method: 'POST',
      url: '/v1/publish',
      payload: await publishBody('com.acme.tool', '1.0.0', 'com.acme'),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/packages/io.github.acme.tool/rename',
      payload: await renameBody(
        'io.github.acme.tool',
        'com.acme.tool',
        'publisher-1',
      ),
    });
    // Otherwise a rename is a way to shadow a name held by someone else.
    expect(response.statusCode).toBe(409);
  });

  it('refuses a publish at a name that has moved', async () => {
    const app = await withPackage(true);
    await app.inject({
      method: 'POST',
      url: '/v1/packages/io.github.acme.tool/rename',
      payload: await renameBody(
        'io.github.acme.tool',
        'com.acme.tool',
        'publisher-1',
      ),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/publish',
      payload: await publishBody(
        'io.github.acme.tool',
        '2.0.0',
        'io.github.acme',
      ),
    });
    // The redirect told everyone the name moved; accepting here would make it
    // a lie, and two live copies of a package is how a lockfile stops meaning
    // one thing.
    expect(response.statusCode).toBe(409);
  });

  it('refuses to follow a redirect loop rather than spinning on it', () => {
    const cycle = new Map<string, PackageRedirect>([
      [
        'a',
        {
          redirectVersion: '1',
          from: 'a',
          to: 'b',
          effectiveAt: '2026-08-10T00:00:00.000Z',
          reason: 'rename',
        },
      ],
      [
        'b',
        {
          redirectVersion: '1',
          from: 'b',
          to: 'a',
          effectiveAt: '2026-08-10T00:00:00.000Z',
          reason: 'rename',
        },
      ],
    ]);
    expect(resolveRedirect('a', cycle)).toEqual({ cycle: true });
  });

  it('follows a chain of renames to where the package actually is', () => {
    const chain = new Map<string, PackageRedirect>([
      [
        'a',
        {
          redirectVersion: '1',
          from: 'a',
          to: 'b',
          effectiveAt: '2026-08-10T00:00:00.000Z',
          reason: 'rename',
        },
      ],
      [
        'b',
        {
          redirectVersion: '1',
          from: 'b',
          to: 'c',
          effectiveAt: '2026-08-10T00:00:00.000Z',
          reason: 'transfer',
        },
      ],
    ]);
    const resolved = resolveRedirect('a', chain);
    expect(resolved).toMatchObject({ name: 'c' });
    // A publisher who moves twice is still resolvable, and the client is told
    // both hops so it can verify each signed document.
    expect('hops' in resolved && resolved.hops).toHaveLength(2);
  });
});
