import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FixtureHttpTransport } from '@openpacker/adapter-core';
import {
  DEFAULT_REGISTRY_ENDPOINTS,
  REGISTRY_ECOSYSTEMS,
  allowedOriginsFor,
  captureFactsFromSourceUri,
  inferFormat,
  listRegistryVersions,
  materializeLockPackage,
  providerFor,
  registryOptionsForEcosystem,
  registryEndpoint,
  resolveManifestToLock,
  resolveRegistryArtifact,
  searchRegistry,
  selectToolBin,
  fetchTool,
  OpmError,
  storeKeyFromDigest,
  type OpmManifest,
} from '../src/index.js';
import {
  bindVerifiedArtifactBytes,
  sealVerifiedArtifactBinding,
} from '../src/install.js';
import {
  firstPartyTransport,
  resolveRegistryArtifactDeferred,
} from '../src/registry.js';

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
      ['cargo', 'golang', 'maven', 'npm', 'nuget', 'oci', 'pypi'].sort(),
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
      // Naming a registry is what authorizing it means — and D6-N drops the
      // hardcoded public CDN rather than unioning it with the override.
      expect(allowedOriginsFor('npm')).toContain(
        'https://npm.internal.example',
      );
      expect(allowedOriginsFor('npm')).not.toContain(
        'https://registry.npmjs.org',
      );
    } finally {
      if (previous === undefined) delete process.env.OPM_REGISTRY_NPM;
      else process.env.OPM_REGISTRY_NPM = previous;
    }
  });

  it('keeps the default pypi CDN on the allowlist', () => {
    expect(allowedOriginsFor('pypi')).toContain(
      'https://files.pythonhosted.org',
    );
    expect(allowedOriginsFor('pypi')).toContain('https://pypi.org');
  });

  it('drops hardcoded public CDNs when OPM_REGISTRY_PYPI overrides', () => {
    const previous = process.env.OPM_REGISTRY_PYPI;
    const previousExtras = process.env.OPM_REGISTRY_PYPI_ORIGINS;
    process.env.OPM_REGISTRY_PYPI = 'https://pypi.internal.example';
    delete process.env.OPM_REGISTRY_PYPI_ORIGINS;
    try {
      const allowed = allowedOriginsFor('pypi');
      expect(allowed).toContain('https://pypi.internal.example');
      expect(allowed).not.toContain('https://files.pythonhosted.org');
      expect(allowed).not.toContain('https://pypi.org');
    } finally {
      if (previous === undefined) delete process.env.OPM_REGISTRY_PYPI;
      else process.env.OPM_REGISTRY_PYPI = previous;
      if (previousExtras === undefined)
        delete process.env.OPM_REGISTRY_PYPI_ORIGINS;
      else process.env.OPM_REGISTRY_PYPI_ORIGINS = previousExtras;
    }
  });

  it('re-allowlists an explicit CDN via OPM_REGISTRY_PYPI_ORIGINS', () => {
    const previous = process.env.OPM_REGISTRY_PYPI;
    const previousExtras = process.env.OPM_REGISTRY_PYPI_ORIGINS;
    process.env.OPM_REGISTRY_PYPI = 'https://pypi.internal.example';
    process.env.OPM_REGISTRY_PYPI_ORIGINS = 'https://files.pythonhosted.org';
    try {
      const allowed = allowedOriginsFor('pypi');
      expect(allowed).toContain('https://pypi.internal.example');
      expect(allowed).toContain('https://files.pythonhosted.org');
      expect(allowed).not.toContain('https://pypi.org');
    } finally {
      if (previous === undefined) delete process.env.OPM_REGISTRY_PYPI;
      else process.env.OPM_REGISTRY_PYPI = previous;
      if (previousExtras === undefined)
        delete process.env.OPM_REGISTRY_PYPI_ORIGINS;
      else process.env.OPM_REGISTRY_PYPI_ORIGINS = previousExtras;
    }
  });

  it('fails closed on duplicate extra origins', () => {
    const previous = process.env.OPM_REGISTRY_PYPI_ORIGINS;
    process.env.OPM_REGISTRY_PYPI_ORIGINS =
      'https://files.pythonhosted.org,https://files.pythonhosted.org';
    try {
      expect(() => allowedOriginsFor('pypi')).toThrow(
        /OPM_REGISTRY_PYPI_ORIGINS lists duplicate origin/u,
      );
    } finally {
      if (previous === undefined) delete process.env.OPM_REGISTRY_PYPI_ORIGINS;
      else process.env.OPM_REGISTRY_PYPI_ORIGINS = previous;
    }
  });

  it('fails closed on HTTP extra origins', () => {
    const previous = process.env.OPM_REGISTRY_NPM_ORIGINS;
    process.env.OPM_REGISTRY_NPM_ORIGINS = 'http://cdn.internal.example';
    try {
      expect(() => allowedOriginsFor('npm')).toThrow(/HTTPS origin/u);
    } finally {
      if (previous === undefined) delete process.env.OPM_REGISTRY_NPM_ORIGINS;
      else process.env.OPM_REGISTRY_NPM_ORIGINS = previous;
    }
  });
});

describe('first-party classify-and-pin', () => {
  function recordingFetch() {
    const calls: string[] = [];
    return {
      calls,
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      fetch: (async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return new Response('ok');
      }) as typeof fetch,
    };
  }

  const privateLookup = async () => [{ address: '10.0.0.1', family: 4 }];
  const publicLookup = async () => [{ address: '1.1.1.1', family: 4 }];

  it('refuses split-horizon rebinding of a public default hostname', async () => {
    const { calls, fetch } = recordingFetch();
    const transport = firstPartyTransport('npm', {
      fetch,
      lookup: privateLookup,
    });
    await expect(
      transport.request({ url: 'https://registry.npmjs.org/lodash' }),
    ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_ENDPOINT' });
    expect(calls).toEqual([]);
  });

  it('pins an OPM_REGISTRY_* override so a private address is allowed', async () => {
    const previous = process.env.OPM_REGISTRY_NPM;
    process.env.OPM_REGISTRY_NPM = 'https://internal.example';
    try {
      const { calls, fetch } = recordingFetch();
      const transport = firstPartyTransport('npm', {
        fetch,
        lookup: privateLookup,
      });
      const response = await transport.request({
        url: 'https://internal.example/lodash',
      });
      expect(new TextDecoder().decode(response.body)).toBe('ok');
      expect(calls).toEqual(['https://internal.example/lodash']);
    } finally {
      if (previous === undefined) delete process.env.OPM_REGISTRY_NPM;
      else process.env.OPM_REGISTRY_NPM = previous;
    }
  });

  it('does not pin extra ORIGINS: rebinding the CDN fails closed', async () => {
    const previous = process.env.OPM_REGISTRY_PYPI;
    const previousExtras = process.env.OPM_REGISTRY_PYPI_ORIGINS;
    process.env.OPM_REGISTRY_PYPI = 'https://pypi.internal.example';
    process.env.OPM_REGISTRY_PYPI_ORIGINS = 'https://files.pythonhosted.org';
    try {
      const { calls, fetch } = recordingFetch();
      const transport = firstPartyTransport('pypi', {
        fetch,
        lookup: privateLookup,
      });
      await expect(
        transport.request({
          url: 'https://files.pythonhosted.org/packages/demo.whl',
        }),
      ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_ENDPOINT' });
      expect(calls).toEqual([]);
      const pinned = await transport.request({
        url: 'https://pypi.internal.example/pypi/demo/json',
      });
      expect(new TextDecoder().decode(pinned.body)).toBe('ok');
    } finally {
      if (previous === undefined) delete process.env.OPM_REGISTRY_PYPI;
      else process.env.OPM_REGISTRY_PYPI = previous;
      if (previousExtras === undefined)
        delete process.env.OPM_REGISTRY_PYPI_ORIGINS;
      else process.env.OPM_REGISTRY_PYPI_ORIGINS = previousExtras;
    }
  });

  it('does not allowlist npmjs.org for a named options.endpoint', async () => {
    const { calls, fetch } = recordingFetch();
    const transport = firstPartyTransport('npm', {
      endpoint: 'https://npm.internal.example',
      fetch,
      lookup: publicLookup,
    });
    await expect(
      transport.request({ url: 'https://registry.npmjs.org/lodash' }),
    ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_ENDPOINT' });
    expect(calls).toEqual([]);
    const response = await transport.request({
      url: 'https://npm.internal.example/lodash',
    });
    expect(new TextDecoder().decode(response.body)).toBe('ok');
  });

  it('passes fetch and lookup through providerFor when transport is unset', async () => {
    const { calls, fetch } = recordingFetch();
    const provider = await providerFor('npm', {
      fetch,
      lookup: privateLookup,
    });
    await expect(provider.inspect('pkg:npm/demo@1.0.0')).rejects.toMatchObject({
      code: 'INVALID_PROVIDER_ENDPOINT',
    });
    expect(calls).toEqual([]);
  });

  it('skips DNS when fetch is injected without lookup', async () => {
    const { calls, fetch } = recordingFetch();
    const transport = firstPartyTransport('npm', { fetch });
    const response = await transport.request({
      url: 'https://registry.npmjs.org/lodash',
    });
    expect(new TextDecoder().decode(response.body)).toBe('ok');
    expect(calls).toEqual(['https://registry.npmjs.org/lodash']);
  });
});

describe('registry endpoint validation', () => {
  it('rejects plaintext private registry overrides', () => {
    const previous = process.env.OPM_REGISTRY_NPM;
    process.env.OPM_REGISTRY_NPM = 'http://npm.internal.example';
    try {
      expect(() => registryEndpoint('npm')).toThrow(/must be HTTPS/u);
    } finally {
      if (previous === undefined) delete process.env.OPM_REGISTRY_NPM;
      else process.env.OPM_REGISTRY_NPM = previous;
    }
  });

  it('rejects an unsafe project registry before constructing a provider', () => {
    expect(() =>
      registryOptionsForEcosystem('npm', {
        registries: {
          mirror: {
            id: 'mirror',
            url: 'http://user:secret@mirror.example',
            defaultFor: ['npm'],
          },
        },
      }),
    ).toThrow(/must be HTTPS/u);
  });

  it('copies project plugin bindings into registry options', () => {
    const digest = `sha256:${'a'.repeat(64)}`;
    const plugins = {
      'dev.test.acme': {
        storeDigest: digest,
        artifactOrigins: ['https://cdn.example'],
      },
    };
    expect(
      registryOptionsForEcosystem('npm', { plugins }).pluginBindings,
    ).toEqual(plugins);
    expect(
      registryOptionsForEcosystem(
        'npm',
        { plugins },
        {
          pluginBindings: {
            'dev.test.other': { storeDigest: digest },
          },
        },
      ).pluginBindings,
    ).toEqual({ 'dev.test.other': { storeDigest: digest } });
  });

  it('refuses an ecosystem it has no registry for', async () => {
    expect(() => registryEndpoint('cocoapods')).toThrow(/No registry/u);
    // Discovery path: unregistered purl types fail closed at the adapter host.
    await expect(providerFor('cocoapods')).rejects.toThrow(
      /No adapter is registered|No registry|UNSUPPORTED_ECOSYSTEM/u,
    );
  });
});

describe('project registry authority', () => {
  it('uses the configured endpoint for direct and transitive packages and locks its identity', async () => {
    const endpoint = 'https://mirror.example';
    const packageDocument = (name: string, dependencies = {}) => ({
      name,
      'dist-tags': { latest: '1.0.0' },
      versions: {
        '1.0.0': {
          name,
          version: '1.0.0',
          dependencies,
          dist: {
            tarball: `${endpoint}/${name}/-/${name}-1.0.0.tgz`,
            integrity: TARBALL_SRI,
          },
        },
      },
    });
    const response = (body: unknown) => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify(body)),
    });
    const artifact = {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
      body: TARBALL,
    };
    const transport = new FixtureHttpTransport(
      new Map([
        [
          `${endpoint}/demo`,
          response(packageDocument('demo', { child: '1.0.0' })),
        ],
        [`${endpoint}/child`, response(packageDocument('child'))],
        [`${endpoint}/demo/-/demo-1.0.0.tgz`, artifact],
        [`${endpoint}/child/-/child-1.0.0.tgz`, artifact],
      ]),
    );
    const manifest: OpmManifest = {
      project: { name: 'authority-test', ecosystems: ['npm'] },
      packages: {
        demo: {
          alias: 'demo',
          purl: 'pkg:npm/demo',
          version: '1.0.0',
          bins: [{ name: 'demo', path: 'bin.js' }],
        },
      },
      registries: {
        mirror: { id: 'mirror', url: endpoint, defaultFor: ['npm'] },
      },
      options: { offline: false, layout: 'opm' },
      policy: {
        allowYanked: false,
        allowQuarantined: false,
        semanticLossMaximum: 'error',
        requiredEvidence: [],
      },
    };
    const root = await mkdtemp(join(tmpdir(), 'opm-authority-'));
    try {
      const lock = await resolveManifestToLock({
        root,
        manifest,
        offline: false,
        registryOptions: {
          transport,
          now: () => '2026-08-04T00:00:00Z',
        },
      });
      expect(transport.requests.length).toBeGreaterThan(0);
      expect(
        transport.requests.every(({ url }) => url.startsWith(`${endpoint}/`)),
      ).toBe(true);
      expect(
        Object.values(lock.packages).map(({ registryId }) => registryId),
      ).toEqual(expect.arrayContaining([endpoint, endpoint]));
      expect(Object.values(lock.packages).map(({ purl }) => purl)).toContain(
        'pkg:npm/child@1.0.0',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('offline is fail-closed', () => {
  it('refuses every registry operation while offline', async () => {
    // The whole offline posture rests on this: an offline build must not be
    // able to start depending on a registry being reachable.
    await expect(providerFor('npm', { offline: true })).rejects.toBeInstanceOf(
      OpmError,
    );
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

  it('refuses a hijacked origin on the deferred inspect-descriptor path too', async () => {
    const hijacked = structuredClone(PACKUMENT);
    hijacked.versions['1.1.0'].dist.tarball =
      'https://evil.example/demo-1.1.0.tgz';
    hijacked.versions['1.1.0'].dist.size = TARBALL.byteLength;
    const transport = new FixtureHttpTransport(
      npmFixtures(hijacked, 'https://evil.example/demo-1.1.0.tgz'),
    );
    await expect(
      resolveRegistryArtifactDeferred('npm', 'pkg:npm/demo@1.1.0', {
        transport,
        now: () => '2026-08-04T00:00:00Z',
      }),
    ).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    expect(
      transport.requests.filter((request) => request.url.endsWith('.tgz')),
    ).toHaveLength(0);
  });

  it('rejects registry metadata for a different package identity', async () => {
    const substituted = structuredClone(PACKUMENT);
    substituted.versions['1.1.0'].name = 'attacker-package';
    await expect(
      resolveRegistryArtifact('npm', 'pkg:npm/demo@1.1.0', {
        transport: new FixtureHttpTransport(npmFixtures(substituted)),
        now: () => '2026-08-04T00:00:00Z',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_METADATA' });
  });
});

describe('OCI image materialisation', () => {
  const configBytes = new TextEncoder().encode(
    '{"architecture":"amd64","os":"linux","rootfs":{"type":"layers","diff_ids":[]}}',
  );
  const layerBytes = new TextEncoder().encode('layer-bytes');
  const configDigest =
    'sha256:c5b1d63604f273462ef36fadac3182d43ae6a6138731cf594b314835cf1c034f';
  const layerDigest =
    'sha256:d50fdce899b75695aa4d7bfb84396fbe2fdee1c92f0dd621d245156cad6f51c0';
  const manifest = {
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.manifest.v1+json',
    config: {
      mediaType: 'application/vnd.oci.image.config.v1+json',
      digest: configDigest,
      size: configBytes.byteLength,
    },
    layers: [
      {
        mediaType: 'application/vnd.oci.image.layer.v1.tar',
        digest: layerDigest,
        size: layerBytes.byteLength,
      },
    ],
  };
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));

  function ociFetch(requests: string[] = []): typeof fetch {
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    return (async (url: URL | string) => {
      const href = String(url);
      requests.push(href);
      if (href.includes('/manifests/'))
        return new Response(manifestBytes, {
          status: 200,
          headers: {
            'content-type': 'application/vnd.oci.image.manifest.v1+json',
          },
        });
      if (href.includes(`/blobs/${encodeURIComponent(configDigest)}`))
        return new Response(configBytes, { status: 200 });
      if (href.includes(`/blobs/${encodeURIComponent(layerDigest)}`))
        return new Response(layerBytes, { status: 200 });
      return new Response('missing', { status: 404 });
    }) as typeof fetch;
  }

  it('classifies an OCI layout media type as plain tar, not gzip', () => {
    expect(
      inferFormat(
        'https://registry-1.docker.io/v2/library/demo/manifests/sha256:abc',
        'application/vnd.oci.image.layout.v1.tar',
      ),
    ).toBe('tar');
  });

  it('resolves and materialises a layout into the project store', async () => {
    const requests: string[] = [];
    const artifact = await resolveRegistryArtifact(
      'oci',
      'pkg:oci/library/demo?tag=1.0',
      { fetch: ociFetch(requests), now: () => '2026-08-04T00:00:00Z' },
    );
    expect(
      requests.filter((request) => request.endsWith('/manifests/1.0')),
    ).toHaveLength(2);
    expect(
      requests.some((request) =>
        /\/manifests\/sha256(?:%3A|:)[0-9a-f]{64}$/u.test(request),
      ),
    ).toBe(true);
    expect(artifact.mediaType).toBe('application/vnd.oci.image.layout.v1.tar');
    expect(artifact.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(artifact.bytes.byteLength).toBeGreaterThan(0);
    // Image identity (PURL version) is the manifest digest; store digest is
    // over the layout tar and must not be silently conflated.
    expect(artifact.version).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(artifact.digest).not.toBe(artifact.version);

    const root = await mkdtemp(join(tmpdir(), 'opm-oci-'));
    const storeKey = storeKeyFromDigest(artifact.digest);
    const pkg = {
      alias: 'demo',
      purl: artifact.exactPurl,
      version: artifact.version,
      digest: artifact.digest,
      size: artifact.bytes.byteLength,
      format: 'tar' as const,
      mediaType: artifact.mediaType,
      source: artifact.uri,
      storeKey,
      bins: [],
      reason: 'direct' as const,
      ecosystem: 'oci',
      lifecycle: { status: 'published' as const, eligible: true },
      publishedAt: '2020-01-01T00:00:00.000Z',
    };
    const facts = captureFactsFromSourceUri(pkg.purl, pkg.source, {
      evaluationTime: '2026-08-04T00:00:00Z',
      fromRegistryArtifactRecord: true,
      lifecycle: pkg.lifecycle,
    });
    facts.publishedAt = pkg.publishedAt;
    bindVerifiedArtifactBytes(pkg, artifact.bytes, 'registry', facts);
    sealVerifiedArtifactBinding(pkg);
    const { storePath } = await materializeLockPackage({
      root,
      offline: true,
      pkg,
      bytes: artifact.bytes,
    });

    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const layout = JSON.parse(
      await readFile(join(storePath, 'oci-layout'), 'utf8'),
    ) as { imageLayoutVersion: string };
    expect(layout.imageLayoutVersion).toBe('1.0.0');
    const blobs = await readdir(join(storePath, 'blobs', 'sha256'));
    expect(blobs).toEqual(
      expect.arrayContaining([
        configDigest.slice('sha256:'.length),
        layerDigest.slice('sha256:'.length),
      ]),
    );
  });

  it('deferred resolution uses the layout-tar digest, not the inspect manifest digest', async () => {
    const eager = await resolveRegistryArtifact(
      'oci',
      'pkg:oci/library/demo?tag=1.0',
      { fetch: ociFetch(), now: () => '2026-08-04T00:00:00Z' },
    );
    const deferred = await resolveRegistryArtifactDeferred(
      'oci',
      'pkg:oci/library/demo?tag=1.0',
      { fetch: ociFetch(), now: () => '2026-08-04T00:00:00Z' },
    );
    expect(deferred.digest).toBe(eager.digest);
    expect(deferred.digest).not.toBe(eager.version);
    expect(deferred.bytes).toEqual(eager.bytes);
    const fetched = await deferred.fetchBytes();
    expect(fetched).toEqual(eager.bytes);
    expect(`sha256:${createHash('sha256').update(fetched).digest('hex')}`).toBe(
      eager.digest,
    );
  });
});

describe('ephemeral tool selection', () => {
  const tool = (
    bins: { name: string; path: string }[],
    purl = 'pkg:npm/demo@1.0.0',
  ) => ({
    exactPurl: purl,
    digest: `sha256:${'a'.repeat(64)}`,
    storePath: '/tmp/store',
    bins,
    cached: false,
  });

  it('runs the only executable without being told which', () => {
    expect(
      selectToolBin(tool([{ name: 'anything', path: 'package/bin/x.js' }]))
        .name,
    ).toBe('anything');
  });

  it('prefers the executable named after the package', () => {
    // `npx eslint` must run eslint, not whichever entry happens to sort first.
    const chosen = selectToolBin(
      tool(
        [
          { name: 'aaa-helper', path: 'package/bin/a.js' },
          { name: 'demo', path: 'package/bin/demo.js' },
        ],
        'pkg:npm/demo@1.0.0',
      ),
    );
    expect(chosen.name).toBe('demo');
  });

  it('refuses to guess when several executables and none matches', () => {
    // Silently running a different tool than the one asked for is worse than
    // an error.
    expect(() =>
      selectToolBin(
        tool([
          { name: 'one', path: 'package/bin/one.js' },
          { name: 'two', path: 'package/bin/two.js' },
        ]),
      ),
    ).toThrow(/--bin/u);
  });

  it('honours an explicit choice and names the alternatives when wrong', () => {
    const bins = [
      { name: 'one', path: 'package/bin/one.js' },
      { name: 'two', path: 'package/bin/two.js' },
    ];
    expect(selectToolBin(tool(bins), 'two').name).toBe('two');
    expect(() => selectToolBin(tool(bins), 'three')).toThrow(/one, two/u);
  });

  it('says so when a package ships nothing runnable', () => {
    expect(() => selectToolBin(tool([]))).toThrow(/no executable/u);
  });

  it('refuses an ephemeral run offline rather than pretending to work', async () => {
    // There is no lockfile here, so an ephemeral run is registry resolution by
    // definition.
    await expect(
      fetchTool({ purl: 'pkg:npm/demo@1.0.0', offline: true }),
    ).rejects.toMatchObject({ code: 'OFFLINE' });
  });

  it('refuses an ecosystem it cannot resolve', async () => {
    await expect(
      fetchTool({ purl: 'pkg:cocoapods/demo@1.0.0' }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_ECOSYSTEM' });
  });
});

describe('ephemeral tool cache (first-party)', () => {
  // The default npm endpoint is served through the `fetch` handed to
  // fetchTool: production dials the pinned address of the real registry, which
  // a stubbed global never sees. The tarball URL stands in for the byte
  // download and the packument URL for registry metadata.
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
  const PACKUMENT_URL = 'https://registry.npmjs.org/demo-tool';
  const TARBALL_URL =
    'https://registry.npmjs.org/demo-tool/-/demo-tool-1.1.0.tgz';

  it('skips the byte download when the resolved digest is already cached', async () => {
    const tgz = new Uint8Array(
      await readFile(join(repoRoot, 'fixtures/opm/demo-tool-1.1.0.tgz')),
    );
    // The packument publishes a sha256 SRI and the byte size, so the
    // inspection alone pins the artifact descriptor and the record call —
    // the download — is deferred until the cache says it is needed.
    const packument = {
      name: 'demo-tool',
      'dist-tags': { latest: '1.1.0' },
      time: { '1.1.0': '2020-01-01T00:00:00.000Z' },
      versions: {
        '1.1.0': {
          name: 'demo-tool',
          version: '1.1.0',
          dist: {
            tarball: TARBALL_URL,
            integrity: `sha256-${createHash('sha256').update(tgz).digest('base64')}`,
            size: tgz.byteLength,
          },
        },
      },
    };
    const requests: string[] = [];
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const registryFetch = (async (input: URL | Request | string) => {
      const url = String(input);
      requests.push(url);
      if (url === PACKUMENT_URL)
        return new Response(JSON.stringify(packument), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      if (url === TARBALL_URL)
        return new Response(tgz, {
          status: 200,
          headers: { 'content-type': 'application/octet-stream' },
        });
      return new Response('missing', { status: 404 });
    }) as typeof fetch;
    const cacheRoot = await mkdtemp(join(tmpdir(), 'opm-npm-cache-'));
    const tarballs = () =>
      requests.filter((url) => url.endsWith('.tgz')).length;
    const packuments = () =>
      requests.filter((url) => url === PACKUMENT_URL).length;
    try {
      const first = await fetchTool({
        purl: 'pkg:npm/demo-tool@1.1.0',
        cacheRoot,
        fetch: registryFetch,
      });
      expect(first.cached).toBe(false);
      expect(first.bins.map((bin) => bin.name)).toEqual(['demo-tool']);
      expect(tarballs()).toBe(1);
      const metadataAfterFirst = packuments();

      const second = await fetchTool({
        purl: 'pkg:npm/demo-tool@1.1.0',
        cacheRoot,
        fetch: registryFetch,
      });
      expect(second.cached).toBe(true);
      expect(second.storePath).toBe(first.storePath);
      expect(second.bins).toEqual(first.bins);
      // The artifact bytes did not move again...
      expect(tarballs()).toBe(1);
      // ...but the registry metadata was re-read: resolution is not cached.
      expect(packuments()).toBeGreaterThan(metadataAfterFirst);
    } finally {
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });
});
