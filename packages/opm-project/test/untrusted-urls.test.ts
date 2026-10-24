import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  FixtureHttpTransport,
  type CatalogProvider,
  type FrozenLockPackage,
  type PackageInstance,
  type ProviderInspection,
  type ProviderRecord,
} from '@openpacker/adapter-core';
import {
  OpmError,
  fetchArtifactBytes,
  registryEndpoint,
  requireAdapterRegistry,
  resolveRegistryArtifact,
  type AdapterModule,
} from '../src/index.js';
import { frozenFacts } from '../src/frozen-policy.js';
import { transportForSources } from '../src/frozen-fetch.js';
import {
  publishPackedArtifact,
  yankRegistryVersion,
} from '../src/publish-client.js';
import {
  captureFactsFromInspection,
  captureFactsFromSourceUri,
} from '../src/supply-chain.js';

/**
 * Every place in this package that reads a URL out of a registry's document, a
 * lock, or a manifest answers a host no DNS name could be without handing it to
 * the URL parser, which takes most of a second on 65,550 characters of it
 * (`@openpacker/canonical`'s `untrusted-url.test.ts` measures that), and says
 * so without repeating any of it. The time is the thing under test.
 */
const HOST = 'ß.é.'.repeat(16384);
const HOSTILE = `https://${HOST}/demo/-/demo-1.1.0.tgz`;
const FAST_MS = 50;
const NPM = 'https://registry.npmjs.org';

/** What `run` throws or rejects with, and the least of three tries of how long that took. */
async function timed(
  run: () => void,
): Promise<{ error: Error | undefined; ms: number; value: unknown }> {
  let error: Error | undefined;
  let value: unknown;
  let ms = Infinity;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const started = performance.now();
    try {
      value = await run();
    } catch (caught) {
      error ??= caught instanceof Error ? caught : new Error(String(caught));
    }
    ms = Math.min(ms, performance.now() - started);
  }
  return { error, ms, value };
}

async function expectOpmRefusal(
  run: () => void,
  code: string,
): Promise<OpmError> {
  const { error, ms } = await timed(run);
  expect(error).toBeInstanceOf(OpmError);
  if (!(error instanceof OpmError)) throw new Error('not an OpmError');
  expect(error.code).toBe(code);
  expect(error.message).not.toContain('ß');
  expect(error.message.length).toBeLessThan(600);
  expect(ms).toBeLessThan(FAST_MS);
  return error;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the registry endpoint, from the environment', () => {
  const saved = process.env.OPM_REGISTRY_NPM;
  afterEach(() => {
    if (saved === undefined) delete process.env.OPM_REGISTRY_NPM;
    else process.env.OPM_REGISTRY_NPM = saved;
  });

  it('is not read when its host is longer than a name can be', async () => {
    process.env.OPM_REGISTRY_NPM = `https://${HOST}`;
    await expectOpmRefusal(
      () => registryEndpoint('npm'),
      'INVALID_PROVIDER_ENDPOINT',
    );
  });
});

describe('a registry that publishes a download location', () => {
  const TARBALL = new Uint8Array([0x1f, 0x8b, 8, 0, 1, 2, 3, 4]);
  const SRI = `sha256-${createHash('sha256').update(TARBALL).digest('base64')}`;

  function packument(tarball: string): Map<string, FixtureResponse> {
    const document = {
      name: 'demo',
      'dist-tags': { latest: '1.1.0' },
      versions: {
        '1.1.0': {
          name: 'demo',
          version: '1.1.0',
          dist: { tarball, integrity: SRI },
        },
      },
    };
    return new Map([
      [
        `${NPM}/demo`,
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: new TextEncoder().encode(JSON.stringify(document)),
        },
      ],
      [
        tarball,
        {
          status: 200,
          headers: { 'content-type': 'application/octet-stream' },
          body: TARBALL,
        },
      ],
    ]);
  }
  type FixtureResponse = {
    status: number;
    headers: Record<string, string>;
    body: Uint8Array;
  };

  it('is refused by name when its host is longer than a name can be', async () => {
    const refusal = await expectOpmRefusal(
      () =>
        resolveRegistryArtifact('npm', 'pkg:npm/demo@1.1.0', {
          transport: new FixtureHttpTransport(packument(HOSTILE)),
          now: () => '2026-08-04T00:00:00Z',
        }),
      'UNSAFE_PATH',
    );
    expect(refusal.message).toContain('pkg:npm/demo@1.1.0');
  });

  it('is read as before when it is an ordinary address', async () => {
    const artifact = await resolveRegistryArtifact(
      'npm',
      'pkg:npm/demo@1.1.0',
      {
        transport: new FixtureHttpTransport(
          packument(`${NPM}/demo/-/demo-1.1.0.tgz`),
        ),
        now: () => '2026-08-04T00:00:00Z',
      },
    );
    expect(artifact.uri).toBe(`${NPM}/demo/-/demo-1.1.0.tgz`);
  });
});

describe('a delegated provider that publishes a download location', () => {
  const ENDPOINT = 'https://acme.fixture.test';
  const EXACT = 'pkg:acme/demo@1.0.0';
  const DIGEST = createHash('sha256').update('bytes').digest('hex');

  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  const INSTANCE = {
    nodeId: `sha256:${DIGEST}`,
    identity: {
      canonicalPurl: 'pkg:acme/demo',
      purlType: 'acme',
      name: 'demo',
      qualifiers: {},
      nativeCoordinates: [],
      aliases: [],
      sourceRefs: [],
      publisherRefs: [],
      externalRefs: [],
      exactPurl: EXACT,
    },
    nativeVersion: '1.0.0',
    normalizedVersion: '1.0.0',
    versionSortKey: '1.0.0',
    requirements: [],
    capabilities: [],
    conflicts: [],
    cardinalityConstraints: [],
    artifacts: [],
    lifecycle: { status: 'published', eligible: true, warnings: [] },
    sourceSnapshots: [],
    metadataDigest: { algorithm: 'sha256', value: DIGEST },
    nativeSemantics: { version: 'acme-1', data: {} },
    semanticLoss: [],
  } as PackageInstance;

  function provider(uri: string, endpoint: string): CatalogProvider {
    const body = {
      digest: { algorithm: 'sha256', value: DIGEST },
      size: 5,
      mediaType: 'application/x-tar',
      locations: [{ uri }],
    };
    const record: ProviderRecord = {
      key: EXACT,
      endpoint,
      body,
      rawBody: new TextEncoder().encode(JSON.stringify(body)),
      retrievedAt: '2020-01-01T00:00:00Z',
    };
    const inspection: ProviderInspection = {
      package: INSTANCE,
      record: { ...record, body: { time: {} } },
      warnings: [],
    };
    return {
      providerId: 'dev.test.acme',
      capabilities: {
        operations: ['identify', 'enumerate', 'inspect', 'artifact'],
        purlTypes: ['acme'],
        qualifierSupport: 'none',
        targetSpecificSemantics: false,
        offlineReplay: false,
        extensions: { 'openpacker/artifact-bytes': 'host-fetch' },
      },
      identify: async () => [INSTANCE.identity],
      enumerate: async () => [EXACT],
      inspect: async () => inspection,
      fetchArtifactRecord: async () => record,
      snapshot: async () => {
        throw new Error('not implemented in fixture');
      },
    };
  }

  function register(candidate: CatalogProvider): void {
    const module: AdapterModule = {
      id: 'dev.test.acme',
      purlTypes: ['acme'],
      registryDefinition: () => ({
        registryDefinitionVersion: '1',
        registryId: ENDPOINT,
        purlTypes: ['acme'],
        resources: [
          { '@id': '#metadata', '@type': 'prex.registry.package-metadata/1' },
          { '@id': '#artifact', '@type': 'prex.registry.artifact/1' },
        ],
      }),
      catalog: () => candidate,
    };
    requireAdapterRegistry().register(module);
  }

  it.each([
    ['location', HOSTILE, ENDPOINT],
    ['endpoint', `${ENDPOINT}/a.tar`, `https://${HOST}`],
  ])(
    'is refused by name when its %s names a host no DNS name could be',
    async (_which, uri, endpoint) => {
      register(provider(uri, endpoint));
      await expectOpmRefusal(
        () =>
          resolveRegistryArtifact('acme', EXACT, {
            lookup: async () => [{ address: '104.16.0.1', family: 4 }],
            fetch: async () => new Response('never asked'),
          }),
        'UNSAFE_PATH',
      );
    },
  );
});

describe('a lock that names a source', () => {
  const lockPackage = (source: string): FrozenLockPackage => ({
    path: 'node_modules/demo',
    name: 'demo',
    packageName: 'demo',
    version: '1.1.0',
    purl: 'pkg:npm/demo',
    exactPurl: 'pkg:npm/demo@1.1.0',
    source,
    sourceKind: 'registry',
    integrity: 'sha512-x',
    direct: true,
    scope: 'runtime',
    hasInstallScript: false,
  });

  it('reads no scheme out of an address whose host is longer than a name can be', async () => {
    const { value, ms } = await timed(() =>
      frozenFacts(lockPackage(HOSTILE), 'npm', '2026-10-11T12:00:00.000Z'),
    );
    expect(ms).toBeLessThan(FAST_MS);
    expect(value).not.toHaveProperty('sourceScheme');
  });

  it('is not given a transport to reach such a host', async () => {
    const refusal = await expectOpmRefusal(
      () => transportForSources('npm', [HOSTILE], {}),
      'UNSAFE_SOURCE',
    );
    expect(refusal.message).toBe('[url] is not a URL opm can fetch');
  });

  it('still reads the scheme of an ordinary address', () => {
    expect(
      frozenFacts(
        lockPackage(`${NPM}/demo/-/demo-1.1.0.tgz`),
        'npm',
        '2026-10-11T12:00:00.000Z',
      ),
    ).toMatchObject({ sourceScheme: 'https' });
  });
});

describe('the supply-chain facts of a source', () => {
  it('call such an address exotic, without reading it', async () => {
    const { value, ms } = await timed(() =>
      captureFactsFromSourceUri('pkg:npm/demo@1.1.0', HOSTILE, {
        evaluationTime: '2026-10-11T12:00:00.000Z',
      }),
    );
    expect(ms).toBeLessThan(FAST_MS);
    expect(value).toMatchObject({ sourceKind: 'exotic' });
  });

  it('read no scheme out of the endpoint a record names', async () => {
    const body = {
      versions: {
        '1.1.0': { dist: { tarball: HOSTILE } },
      },
    };
    const inspection: ProviderInspection = {
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      package: {
        identity: { exactPurl: 'pkg:npm/demo@1.1.0', purlType: 'npm' },
        nativeVersion: '1.1.0',
        lifecycle: { status: 'published', eligible: true, warnings: [] },
        sourceSnapshots: [],
        semanticLoss: [],
      } as PackageInstance,
      record: {
        key: 'pkg:npm/demo@1.1.0',
        endpoint: HOSTILE,
        body,
        rawBody: new TextEncoder().encode(JSON.stringify(body)),
        retrievedAt: '2020-01-01T00:00:00Z',
      },
      warnings: [],
    };
    const { value, ms } = await timed(() =>
      captureFactsFromInspection(inspection, {
        evaluationTime: '2026-10-11T12:00:00.000Z',
      }),
    );
    expect(ms).toBeLessThan(FAST_MS);
    expect(value).toMatchObject({ sourceKind: 'registry' });
    expect(value).not.toHaveProperty('sourceScheme');
  });
});

describe('a source a person or a manifest names', () => {
  it('is not fetched when its host is longer than a name can be', async () => {
    const asked = vi.fn(async () => new Response('never asked'));
    vi.stubGlobal('fetch', asked);
    const refusal = await expectOpmRefusal(
      () => fetchArtifactBytes(HOSTILE, false),
      'UNSAFE_SOURCE',
    );
    expect(asked).not.toHaveBeenCalled();
    expect(refusal.message).toContain('[url]');
  });

  it('is not read as a file when its host is longer than a name can be', async () => {
    await expectOpmRefusal(
      () => fetchArtifactBytes(`file://${HOST}/etc/passwd`, false),
      'UNSAFE_SOURCE',
    );
  });
});

describe('the registry a person publishes or yanks to', () => {
  it.each([
    ['publish', () => publishPackedArtifact({ registry: `https://${HOST}` })],
    [
      'yank',
      () =>
        yankRegistryVersion({
          purl: 'pkg:npm/demo@1.1.0',
          registry: `https://${HOST}`,
        }),
    ],
  ])(
    'is refused for %s when its host is longer than a name can be',
    async (_verb, run) => {
      await expectOpmRefusal(run, 'UNSAFE_PATH');
    },
  );
});
