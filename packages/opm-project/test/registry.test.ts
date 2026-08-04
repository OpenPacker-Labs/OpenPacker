import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { FixtureHttpTransport } from '@openpacker/adapter-core';
import {
  DEFAULT_REGISTRY_ENDPOINTS,
  REGISTRY_ECOSYSTEMS,
  allowedOriginsFor,
  listRegistryVersions,
  providerFor,
  registryEndpoint,
  resolveRegistryArtifact,
  searchRegistry,
  OpmError,
} from '../src/index.js';

/**
 * Registry resolution, driven through a fixture transport.
 *
 * Nothing here touches a real registry: the point of these is the policy —
 * offline refuses, origins are pinned, and a digest the registry publishes is
 * the thing a download has to match. Live registry coverage is opt-in
 * elsewhere and is not a substitute for any of this.
 */

/** Stand-in tarball bytes; nothing here extracts them. */
const TARBALL = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 1, 2, 3, 4]);
const TARBALL_SRI = `sha256-${createHash('sha256').update(TARBALL).digest('base64')}`;
const TARBALL_SHA256 = `sha256:${createHash('sha256').update(TARBALL).digest('hex')}`;

const PACKUMENT = {
  name: 'demo',
  'dist-tags': { latest: '1.1.0' },
  versions: {
    '1.0.0': {
      name: 'demo',
      version: '1.0.0',
      dist: {
        tarball: 'https://registry.npmjs.org/demo/-/demo-1.0.0.tgz',
        integrity: TARBALL_SRI,
      },
    },
    '1.1.0': {
      name: 'demo',
      version: '1.1.0',
      dist: {
        tarball: 'https://registry.npmjs.org/demo/-/demo-1.1.0.tgz',
        integrity: TARBALL_SRI,
      },
    },
  },
};

function npmFixtures(
  packument: unknown = PACKUMENT,
  tarballUrl = 'https://registry.npmjs.org/demo/-/demo-1.1.0.tgz',
) {
  return new Map<
    string,
    { status: number; headers: Record<string, string>; body: Uint8Array }
  >([
    [
      'https://registry.npmjs.org/demo',
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: new TextEncoder().encode(JSON.stringify(packument)),
      },
    ],
    [
      tarballUrl,
      {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
        body: TARBALL,
      },
    ],
  ]);
}

function npmTransport(): FixtureHttpTransport {
  return new FixtureHttpTransport(npmFixtures());
}

const options = () => ({
  transport: npmTransport(),
  now: () => '2026-08-04T00:00:00Z',
});

describe('registry configuration', () => {
  it('covers every ecosystem opm claims to support', () => {
    expect([...REGISTRY_ECOSYSTEMS].sort()).toEqual(
      ['cargo', 'golang', 'maven', 'npm', 'nuget', 'pypi'].sort(),
    );
    for (const ecosystem of REGISTRY_ECOSYSTEMS)
      expect(
        DEFAULT_REGISTRY_ENDPOINTS[ecosystem],
        `${ecosystem} needs a default endpoint`,
      ).toMatch(/^https:\/\//u);
  });

  it('allows the metadata origin and the artifact origins, and nothing else', () => {
    // Registries answer metadata on one host and serve downloads from another,
    // so both are listed — but listed, not discovered from the response.
    expect(allowedOriginsFor('npm')).toContain('https://registry.npmjs.org');
    expect(allowedOriginsFor('pypi')).toContain(
      'https://files.pythonhosted.org',
    );
    for (const ecosystem of REGISTRY_ECOSYSTEMS)
      for (const origin of allowedOriginsFor(ecosystem))
        expect(origin, `${ecosystem} origin must be https`).toMatch(
          /^https:\/\//u,
        );
  });

  it('takes a private registry from the environment', () => {
    const previous = process.env.OPM_REGISTRY_NPM;
    process.env.OPM_REGISTRY_NPM = 'https://npm.internal.example';
    try {
      expect(registryEndpoint('npm')).toBe('https://npm.internal.example');
      // Naming a registry is what authorizing it means.
      expect(allowedOriginsFor('npm')).toContain(
        'https://npm.internal.example',
      );
    } finally {
      if (previous === undefined) delete process.env.OPM_REGISTRY_NPM;
      else process.env.OPM_REGISTRY_NPM = previous;
    }
  });

  it('refuses an ecosystem it has no registry for', () => {
    expect(() => registryEndpoint('cocoapods')).toThrow(/No registry/u);
    expect(() => providerFor('cocoapods')).toThrow(/No registry/u);
  });
});

describe('offline is fail-closed', () => {
  it('refuses every registry operation while offline', async () => {
    // The whole offline posture rests on this: an offline build must not be
    // able to start depending on a registry being reachable.
    expect(() => providerFor('npm', { offline: true })).toThrow(OpmError);
    await expect(
      listRegistryVersions('npm', 'pkg:npm/demo', { offline: true }),
    ).rejects.toMatchObject({ code: 'OFFLINE' });
    await expect(
      searchRegistry('npm', 'demo', { offline: true }),
    ).rejects.toMatchObject({ code: 'OFFLINE' });
    await expect(
      resolveRegistryArtifact('npm', 'pkg:npm/demo@1.1.0', { offline: true }),
    ).rejects.toMatchObject({ code: 'OFFLINE' });
  });

  it('makes no request at all when offline', async () => {
    const transport = npmTransport();
    await expect(
      listRegistryVersions('npm', 'pkg:npm/demo', {
        offline: true,
        transport,
      }),
    ).rejects.toMatchObject({ code: 'OFFLINE' });
    expect(transport.requests).toEqual([]);
  });
});

describe('browsing', () => {
  it('lists published versions oldest first', async () => {
    const versions = await listRegistryVersions(
      'npm',
      'pkg:npm/demo',
      options(),
    );
    expect(versions).toEqual(['pkg:npm/demo@1.0.0', 'pkg:npm/demo@1.1.0']);
  });

  it('identifies a package from a bare name', async () => {
    const found = await searchRegistry('npm', 'demo', options());
    expect(found.map((item) => item.canonicalPurl)).toContain('pkg:npm/demo');
  });
});

describe('artifact resolution', () => {
  it('returns a verifiable artifact: digest, size, bytes, and where to get it', async () => {
    const artifact = await resolveRegistryArtifact(
      'npm',
      'pkg:npm/demo@1.1.0',
      options(),
    );
    expect(artifact.exactPurl).toBe('pkg:npm/demo@1.1.0');
    expect(artifact.digest).toBe(TARBALL_SHA256);
    expect(artifact.uri).toBe(
      'https://registry.npmjs.org/demo/-/demo-1.1.0.tgz',
    );
    // The bytes come back with the descriptor, and the digest is over exactly
    // them — so the install path never has to fetch a second time and hope it
    // got the same thing.
    expect(artifact.bytes).toEqual(TARBALL);
    expect(artifact.size).toBe(TARBALL.byteLength);
  });

  it('downloads the artifact once, not once per check', async () => {
    const transport = new FixtureHttpTransport(npmFixtures());
    await resolveRegistryArtifact('npm', 'pkg:npm/demo@1.1.0', {
      transport,
      now: () => '2026-08-04T00:00:00Z',
    });
    const tarballRequests = transport.requests.filter((request) =>
      request.url.endsWith('.tgz'),
    );
    expect(tarballRequests).toHaveLength(1);
  });

  it('rejects bytes that do not match the integrity the registry published', async () => {
    // The supply-chain case: metadata says one thing, the served bytes are
    // another. The provider checks npm's own SRI before anything downstream
    // sees the artifact.
    const fixtures = npmFixtures();
    fixtures.set('https://registry.npmjs.org/demo/-/demo-1.1.0.tgz', {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
      body: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
    });
    await expect(
      resolveRegistryArtifact('npm', 'pkg:npm/demo@1.1.0', {
        transport: new FixtureHttpTransport(fixtures),
        now: () => '2026-08-04T00:00:00Z',
      }),
    ).rejects.toThrow(/mismatch/iu);
  });

  it('refuses a download location on an unexpected origin', async () => {
    // A registry that starts handing back another host is the interesting
    // failure, so it is refused by name rather than left to the transport.
    const hijacked = structuredClone(PACKUMENT);
    hijacked.versions['1.1.0'].dist.tarball =
      'https://evil.example/demo-1.1.0.tgz';
    // The hostile host answers, and with bytes whose integrity checks out — so
    // the only thing standing between this and an install is the origin rule.
    const transport = new FixtureHttpTransport(
      npmFixtures(hijacked, 'https://evil.example/demo-1.1.0.tgz'),
    );
    await expect(
      resolveRegistryArtifact('npm', 'pkg:npm/demo@1.1.0', {
        transport,
        now: () => '2026-08-04T00:00:00Z',
      }),
    ).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
  });
});
