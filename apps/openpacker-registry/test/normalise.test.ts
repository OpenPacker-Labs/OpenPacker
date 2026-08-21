import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { canonicalDigest, formatDigest } from '@openpacker/canonical';
import { Ed25519Signer } from '@openpacker/trust';
import type { JsonValue, PackageManifest } from '@openpacker/contracts';
import { createRegistry, RegistryStore } from '../src/index.js';
import {
  acceptedVersions,
  normalise,
  representableVersions,
  type ManifestMigration,
} from '../src/normalise.js';

// SAFETY: The surrounding boundary establishes the asserted domain contract.
const keys = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('../../../fixtures/trust/keys.json', import.meta.url),
    ),
    'utf8',
  ),
) as Record<string, JsonWebKey>;

function manifest(
  name: string,
  extra: Partial<PackageManifest> = {},
): PackageManifest {
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  return {
    packageManifestVersion: '1',
    name,
    version: '1.0.0',
    distributions: [
      {
        purlType: 'npm',
        identifier: 'demo',
        version: '1.0.0',
        exactPurl: 'pkg:npm/demo@1.0.0',
        digest: { algorithm: 'sha256', value: '3'.repeat(64) },
        size: 10,
        mediaType: 'application/vnd.npm.install-v1+json',
        locations: ['https://registry.npmjs.org/demo/-/demo-1.0.0.tgz'],
      },
    ],
    ...extra,
  } as PackageManifest;
}

async function publishBody(value: PackageManifest, _namespace: string) {
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  const digest = await canonicalDigest(value as unknown as JsonValue);
  const signer = await Ed25519Signer.fromJwk('publisher-1', keys.leaf!);
  return {
    manifest: value,
    manifestDigest: digest,
    signatures: [
      {
        algorithm: 'ed25519' as const,
        keyId: 'publisher-1',
        signature: await signer.sign(
          new TextEncoder().encode(formatDigest(digest)),
        ),
        role: 'publisher' as const,
      },
    ],
  };
}

async function statusBody(
  name: string,
  version: string,
  status: 'active' | 'deprecated' | 'deleted',
) {
  const update = {
    statusUpdateVersion: '1' as const,
    eventId: `${name}@${version}:${status}`,
    name,
    version,
    status,
    reason: `test transition to ${status}`,
    issuedAt: '2026-08-10T00:00:00.000Z',
  };
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  const updateDigest = await canonicalDigest(update as unknown as JsonValue);
  const signer = await Ed25519Signer.fromJwk('publisher-1', keys.leaf!);
  return {
    update,
    updateDigest,
    signatures: [
      {
        algorithm: 'ed25519' as const,
        keyId: 'publisher-1',
        signature: await signer.sign(
          new TextEncoder().encode(formatDigest(updateDigest)),
        ),
        role: 'publisher' as const,
      },
    ],
  };
}

function registry(overrides: Record<string, unknown> = {}) {
  const store =
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    (overrides.store as RegistryStore | undefined) ?? new RegistryStore();
  store.trustKey(
    'com.example',
    'publisher-1',
    'dns-txt',
    '2026-08-10T00:00:00.000Z',
    'dns:example.com',
  );
  return createRegistry({
    registryId: 'urn:openpacker:registry:test',
    purlTypes: ['npm'],
    store,
    publisherKeys: { 'publisher-1': keys.leaf! },
    clock: { now: () => '2026-08-10T00:00:00.000Z' },
    ...overrides,
  });
}

describe('Accept negotiation', () => {
  it('reads a version out of the media type', () => {
    expect(acceptedVersions('application/vnd.prex.manifest.v1+json')).toEqual([
      1,
    ]);
  });

  it('honours q-values, then the client’s own order', () => {
    expect(
      acceptedVersions(
        'application/vnd.prex.manifest.v1+json;q=0.5, application/vnd.prex.manifest.v2+json',
      ),
    ).toEqual([2, 1]);
  });

  it('drops a version the client refused outright', () => {
    // q=0 means "not this", which is different from not mentioning it.
    expect(
      acceptedVersions(
        'application/vnd.prex.manifest.v1+json;q=0, application/vnd.prex.manifest.v2+json',
      ),
    ).toEqual([2]);
  });

  it('treats a wildcard or a missing header as no preference', () => {
    // Not as "nothing is acceptable" — a client sending */* wants whatever
    // there is, and answering 406 to it would be absurd.
    expect(acceptedVersions('*/*')).toEqual([]);
    expect(acceptedVersions(undefined)).toEqual([]);
    expect(acceptedVersions('application/json')).toEqual([]);
  });
});

describe('read-time normalisation', () => {
  /** A synthetic v1 → v2 migration, so the machinery is exercised, not asserted. */
  const toV2: ManifestMigration = {
    from: 1,
    to: 2,
    migrate: (value) =>
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      ({
        ...value,
        packageManifestVersion: '2',
        summary: value.description ?? '',
      }) as unknown as PackageManifest,
  };
  const toV1: ManifestMigration = {
    from: 2,
    to: 1,
    migrate: (value) =>
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      ({ ...value, packageManifestVersion: '1' }) as unknown as PackageManifest,
  };

  it('serves what is stored when the client accepts it', () => {
    const stored = manifest('com.example.tool');
    expect(normalise(stored, [1], [toV2])).toBe(stored);
  });

  it('migrates forward to the version the client asked for', () => {
    const migrated = normalise(manifest('com.example.tool'), [2], [toV2]);
    expect(migrated?.packageManifestVersion).toBe('2');
  });

  it('takes the shortest route when more than one exists', () => {
    const long: ManifestMigration = {
      from: 1,
      to: 3,
      migrate: (value) =>
        // SAFETY: The surrounding boundary establishes the asserted domain contract.
        ({ ...value, packageManifestVersion: '3', via: 'direct' }) as never,
    };
    const stepA: ManifestMigration = {
      from: 1,
      to: 2,
      migrate: (value) =>
        // SAFETY: The surrounding boundary establishes the asserted domain contract.
        ({ ...value, packageManifestVersion: '2', via: 'stepA' }) as never,
    };
    const stepB: ManifestMigration = {
      from: 2,
      to: 3,
      migrate: (value) =>
        // SAFETY: The surrounding boundary establishes the asserted domain contract.
        ({ ...value, packageManifestVersion: '3', via: 'stepB' }) as never,
    };
    // Every hop is a chance to lose something, so a direct conversion beats
    // two even when the two were registered first.
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const result = normalise(
      manifest('com.example.tool'),
      [3],
      [stepA, stepB, long],
    ) as unknown as { via: string };
    expect(result.via).toBe('direct');
  });

  it('reports nothing when no chain reaches an acceptable version', () => {
    expect(
      normalise(manifest('com.example.tool'), [9], [toV2]),
    ).toBeUndefined();
  });

  it('lists what a document can be represented as', () => {
    expect(representableVersions(1, [toV2, toV1])).toEqual([1, 2]);
    expect(representableVersions(1, [])).toEqual([1]);
  });

  it('answers 406 rather than a document the client will mis-parse', async () => {
    const app = registry();
    await app.inject({
      method: 'POST',
      url: '/v1/publish',
      payload: await publishBody(manifest('com.example.tool'), 'com.example'),
    });
    const response = await app.inject({
      method: 'GET',
      url: '/v1/packages/com.example.tool/versions/1.0.0',
      headers: { accept: 'application/vnd.prex.manifest.v7+json' },
    });
    // A mis-parse is silent; a 406 is not. This is the half MCP is missing —
    // validating on the way in does nothing for a client meeting a document
    // published under a schema it has never seen.
    expect(response.statusCode).toBe(406);
    expect(response.json().detail).toContain('version 1');
  });

  it('serves a migrated document and says which version it is', async () => {
    const app = registry({ manifestMigrations: [toV2] });
    await app.inject({
      method: 'POST',
      url: '/v1/publish',
      payload: await publishBody(manifest('com.example.tool'), 'com.example'),
    });
    const response = await app.inject({
      method: 'GET',
      url: '/v1/packages/com.example.tool/versions/1.0.0',
      headers: { accept: 'application/vnd.prex.manifest.v2+json' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().manifest.packageManifestVersion).toBe('2');
    expect(response.headers['content-type']).toContain(
      'application/vnd.prex.manifest.v2+json',
    );
  });

  it('serves a client that states no preference', async () => {
    const app = registry();
    await app.inject({
      method: 'POST',
      url: '/v1/publish',
      payload: await publishBody(manifest('com.example.tool'), 'com.example'),
    });
    const response = await app.inject({
      method: 'GET',
      url: '/v1/packages/com.example.tool/versions/1.0.0',
    });
    expect(response.statusCode).toBe(200);
  });
});

describe('search', () => {
  async function stocked() {
    const app = registry();
    await app.inject({
      method: 'POST',
      url: '/v1/publish',
      payload: await publishBody(
        // SAFETY: The surrounding boundary establishes the asserted domain contract.
        manifest('com.example.parser', {
          description: 'A fast JSON parser for embedded targets',
        } as Partial<PackageManifest>),
        'com.example',
      ),
    });
    await app.inject({
      method: 'POST',
      url: '/v1/publish',
      payload: await publishBody(
        // SAFETY: The surrounding boundary establishes the asserted domain contract.
        manifest('com.example.logger', {
          title: 'Structured logging',
        } as Partial<PackageManifest>),
        'com.example',
      ),
    });
    return app;
  }

  it('finds a package by a word inside its dotted name', async () => {
    const app = await stocked();
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const page = (
      await app.inject({ method: 'GET', url: '/v1/packages?search=parser' })
    ).json() as { packages: { manifest: { name: string } }[] };
    // Names are dotted; someone typing one word means the word, not the name.
    expect(page.packages).toHaveLength(1);
    expect(page.packages[0]?.manifest.name).toBe('com.example.parser');
  });

  it('finds a package by its description', async () => {
    const app = await stocked();
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const page = (
      await app.inject({ method: 'GET', url: '/v1/packages?search=embedded' })
    ).json() as { packages: { manifest: { name: string } }[] };
    expect(page.packages).toHaveLength(1);
    expect(page.packages[0]?.manifest.name).toBe('com.example.parser');
  });

  it('says which search actually ran', async () => {
    const app = await stocked();
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const page = (
      await app.inject({ method: 'GET', url: '/v1/packages?search=parser' })
    ).json() as { metadata: { searchMode?: string } };
    // A registry quietly on a full scan looks exactly like one that is fast.
    expect(page.metadata.searchMode).toBe('indexed');
  });

  it('treats a query-language operator as text, not as syntax', async () => {
    const app = await stocked();
    // `NOT`, `*` and `"` mean something to FTS5. Passing a search box straight
    // through would make some searches syntax errors and others queries the
    // user did not write.
    for (const search of ['parser NOT logger', 'par*', '"unclosed', 'a AND']) {
      const response = await app.inject({
        method: 'GET',
        url: `/v1/packages?search=${encodeURIComponent(search)}`,
      });
      expect(response.statusCode).toBe(200);
    }
  });

  it('returns nothing rather than everything for a search of only punctuation', async () => {
    const app = await stocked();
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const page = (
      await app.inject({ method: 'GET', url: '/v1/packages?search=%2B%2B%2B' })
    ).json() as { packages: unknown[] };
    expect(page.packages).toHaveLength(0);
  });

  it('keeps the index in step when a name changes underneath it', async () => {
    const app = await stocked();
    const store = new RegistryStore();
    // Go through the store directly: a rename is the one operation that changes
    // indexed text after the fact, and an index that is not maintained would
    // keep answering for the name that no longer exists.
    store.publish({
      manifest: manifest('com.example.parser'),
      manifestDigest: 'sha256:' + '1'.repeat(64),
      signatures: [],
      now: '2026-08-10T00:00:00.000Z',
    });
    store.rename(
      'com.example.parser',
      'com.example.reader',
      '2026-08-10T00:00:01.000Z',
    );
    expect(store.list({ search: 'reader', limit: 10 }).entries).toHaveLength(1);
    // The index reads `entries` rather than holding a copy, so there is no
    // second answer to drift away from the first.
    expect(store.list({ search: 'parser', limit: 10 }).entries).toHaveLength(0);
  });

  it('withdrawn entries leave the listing', async () => {
    const app = await stocked();
    await app.inject({
      method: 'PATCH',
      url: '/v1/packages/com.example.parser/versions/1.0.0/status',
      payload: await statusBody('com.example.parser', '1.0.0', 'deleted'),
    });
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const page = (
      await app.inject({ method: 'GET', url: '/v1/packages?search=parser' })
    ).json() as { packages: unknown[] };
    expect(page.packages).toHaveLength(0);
  });
});
