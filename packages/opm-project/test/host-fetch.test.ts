import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { createHash } from 'node:crypto';
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CatalogProvider,
  PackageInstance,
  ProviderInspection,
  ProviderRecord,
} from '@openpacker/adapter-core';
import { findTrustedSandboxHelper } from '@openpacker/sandbox';
import {
  binDeclarationsFromExecutables,
  fetchTool,
  OpmError,
  parseLockfile,
  parseManifest,
  requireAdapterRegistry,
  resolveRegistryArtifact,
  runSandboxedPackageProcess,
  serializeLockfile,
  serializeManifest,
  writeBinShims,
  type AdapterModule,
  type LockPackage,
  type RegistryOptions,
} from '../src/index.js';
import {
  startAcmeArtifactFixtureServer,
  type AcmeArtifactFixtureServer,
} from './acme-artifact-fixture-server.js';

/**
 * Delegated host-side artifact acquisition (spec delegated-adapter.md
 * §Artifact bytes, ADR 0040).
 *
 * A fake adapter module plays the delegated provider: it advertises the
 * `openpacker/artifact-bytes: host-fetch` capability extension and answers
 * inspect/fetch-artifact-record from canned data, exactly the surface
 * plugin-host's DelegatedCatalogProvider produces. The artifact bytes
 * themselves are served by a fetch stub — nothing here touches the network.
 */

const ENDPOINT = 'https://acme.fixture.test';
const EXACT = 'pkg:acme/demo@1.0.0';
const TOOL_SCRIPT = '#!/bin/sh\necho acme-tool-ok "$@"\n';

/** Smallest tar that materializes, with real modes (no dependencies). */
function tarEntry(name: string, data: Uint8Array, mode: number): Uint8Array {
  const header = new Uint8Array(512);
  const text = (offset: number, value: string) =>
    header.set(new TextEncoder().encode(value), offset);
  text(0, name);
  text(100, `${mode.toString(8).padStart(7, '0')}\0`);
  text(108, '0000000\0');
  text(116, '0000000\0');
  text(124, `${data.byteLength.toString(8).padStart(11, '0')}\0`);
  text(136, '00000000000\0');
  header.fill(0x20, 148, 156);
  header[156] = '0'.charCodeAt(0);
  text(257, 'ustar\0');
  text(263, '00');
  text(329, '0000000\0');
  text(337, '0000000\0');
  let sum = 0;
  for (const byte of header) sum += byte;
  text(148, `${sum.toString(8).padStart(6, '0')}\0 `);
  const padded = Math.ceil(data.byteLength / 512) * 512;
  const block = new Uint8Array(512 + padded);
  block.set(header, 0);
  block.set(data, 512);
  return block;
}

const TOOL_TAR = tarEntry(
  'bin/demo',
  new TextEncoder().encode(TOOL_SCRIPT),
  0o755,
);
const TOOL_DIGEST = createHash('sha256').update(TOOL_TAR).digest('hex');

const sha256 = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');

// SAFETY: The surrounding boundary establishes the asserted domain contract.
const INSTANCE: PackageInstance = {
  nodeId: `sha256:${TOOL_DIGEST}`,
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
  metadataDigest: { algorithm: 'sha256', value: TOOL_DIGEST },
  nativeSemantics: { version: 'acme-1', data: {} },
  semanticLoss: [],
} as PackageInstance;

interface DescriptorOverrides {
  digest?: { algorithm: string; value: string };
  size?: number;
  mediaType?: string;
  locations?: readonly { uri: string }[];
}

function descriptor(overrides: DescriptorOverrides = {}) {
  return {
    digest: { algorithm: 'sha256', value: TOOL_DIGEST },
    size: TOOL_TAR.byteLength,
    mediaType: 'application/x-tar',
    locations: [{ uri: `${ENDPOINT}/artifacts/demo-1.0.0.tar` }],
    ...overrides,
  };
}

function acmeProvider(input: {
  hostFetch: boolean;
  body?: DescriptorOverrides;
  executables?: ProviderInspection['executables'];
  endpoint?: string;
}): CatalogProvider {
  const endpoint = input.endpoint ?? ENDPOINT;
  const recordBody = descriptor(input.body);
  const record: ProviderRecord = {
    key: EXACT,
    endpoint,
    body: recordBody,
    // The delegated protocol carries metadata only: rawBody is the canonical
    // bytes of the descriptor, never the artifact.
    rawBody: new TextEncoder().encode(JSON.stringify(recordBody)),
    retrievedAt: '2020-01-01T00:00:00Z',
  };
  const inspection: ProviderInspection = {
    package: INSTANCE,
    record: {
      ...record,
      body: { time: { '1.0.0': '2020-01-01T00:00:00.000Z' } },
    },
    ...(!(input.executables === undefined) && {
      executables: input.executables,
    }),
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
      extensions: input.hostFetch
        ? { 'openpacker/artifact-bytes': 'host-fetch' }
        : {},
    },
    async identify() {
      return [INSTANCE.identity];
    },
    async enumerate() {
      return [EXACT];
    },
    async inspect() {
      return inspection;
    },
    async fetchArtifactRecord() {
      return record;
    },
    async snapshot() {
      throw new Error('not implemented in fixture');
    },
  };
}

function registerAcme(provider: CatalogProvider): void {
  const module: AdapterModule = {
    id: 'dev.test.acme',
    purlTypes: ['acme'],
    registryDefinition: () => ({
      registryDefinitionVersion: '1',
      registryId: ENDPOINT,
      purlTypes: ['acme'],
      resources: [
        { '@id': '#metadata', '@type': 'prex.registry.package-metadata/1' },
        { '@id': '#enumerate', '@type': 'prex.registry.enumerate-versions/1' },
        { '@id': '#artifact', '@type': 'prex.registry.artifact/1' },
      ],
    }),
    catalog: () => provider,
  };
  requireAdapterRegistry().register(module);
}

/** Serve fixed bytes for fixed URLs; everything else 404s. */
function fetchStub(routes: Readonly<Record<string, Uint8Array>>): typeof fetch {
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  return (async (input: URL | Request | string) => {
    const body = routes[String(input)];
    if (body === undefined) return new Response('missing', { status: 404 });
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
    });
  }) as typeof fetch;
}

const tarRoute = { [`${ENDPOINT}/artifacts/demo-1.0.0.tar`]: TOOL_TAR };
const ARTIFACT_URL = `${ENDPOINT}/artifacts/demo-1.0.0.tar`;
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OPM_HOST_FETCH_ORIGINS;
  delete process.env.OPM_HOST_FETCH_REQUIRE_PIN;
  delete process.env.OPM_HOST_FETCH_TOKEN_ENVS;
  delete process.env.OPM_HOST_FETCH_HEADER_NAMES;
  delete process.env.OPM_HOST_FETCH_HEADER_ENVS;
  delete process.env.OPM_HOST_FETCH_BEARER;
  delete process.env.ACME_TOKEN;
  delete process.env.ACME_A_TOKEN;
  delete process.env.ACME_B_TOKEN;
  delete process.env.JFROG_API_KEY;
  delete process.env.JFROG_A_KEY;
  delete process.env.JFROG_B_KEY;
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_USERPROFILE === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = ORIGINAL_USERPROFILE;
});

describe('delegated host-fetch acquisition', () => {
  it('downloads, bounds, and verifies the bytes itself', async () => {
    registerAcme(acmeProvider({ hostFetch: true }));
    let requested: string[] = [];
    const artifact = await resolveRegistryArtifact('acme', EXACT, {
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      fetch: ((input: URL | Request | string) => {
        requested.push(String(input));
        return fetchStub(tarRoute)(input);
      }) as typeof fetch,
    });
    expect(artifact.bytes).toEqual(TOOL_TAR);
    expect(artifact.size).toBe(TOOL_TAR.byteLength);
    expect(artifact.digest).toBe(`sha256:${TOOL_DIGEST}`);
    expect(artifact.uri).toBe(`${ENDPOINT}/artifacts/demo-1.0.0.tar`);
    expect(requested).toEqual([`${ENDPOINT}/artifacts/demo-1.0.0.tar`]);
  });

  it('lets OPM_HOST_FETCH_REQUIRE_PIN refuse an unpinned public endpoint origin', async () => {
    process.env.OPM_HOST_FETCH_REQUIRE_PIN = '1';
    registerAcme(acmeProvider({ hostFetch: true }));
    let fetched = false;
    await expect(
      resolveRegistryArtifact('acme', EXACT, {
        // SAFETY: The surrounding boundary establishes the asserted domain contract.
        fetch: (async () => {
          fetched = true;
          return new Response(TOOL_TAR);
        }) as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    expect(fetched).toBe(false);
  });

  it('fetches when OPM_HOST_FETCH_REQUIRE_PIN and the origin is pinned', async () => {
    process.env.OPM_HOST_FETCH_REQUIRE_PIN = 'true';
    process.env.OPM_HOST_FETCH_ORIGINS = ENDPOINT;
    registerAcme(acmeProvider({ hostFetch: true }));
    const artifact = await resolveRegistryArtifact('acme', EXACT, {
      fetch: fetchStub(tarRoute),
    });
    expect(artifact.bytes).toEqual(TOOL_TAR);
  });

  it('surfaces inspect executables as artifact bins', async () => {
    registerAcme(
      acmeProvider({
        hostFetch: true,
        executables: [
          { name: 'demo', path: 'bin/demo', interpreter: 'native' },
        ],
      }),
    );
    const artifact = await resolveRegistryArtifact('acme', EXACT, {
      fetch: fetchStub(tarRoute),
    });
    expect(artifact.bins).toEqual([
      { name: 'demo', path: 'bin/demo', interpreter: 'native' },
    ]);
  });

  it('fails closed when the served bytes digest differently', async () => {
    registerAcme(acmeProvider({ hostFetch: true }));
    // Same length, different content: only the digest check can catch this.
    const corrupted = TOOL_TAR.map((byte) => byte ^ 0xff);
    await expect(
      resolveRegistryArtifact('acme', EXACT, {
        fetch: fetchStub({
          [`${ENDPOINT}/artifacts/demo-1.0.0.tar`]: corrupted,
        }),
      }),
    ).rejects.toMatchObject({ code: 'DIGEST_MISMATCH' });
  });

  it('fails closed when the served body is smaller than the published size', async () => {
    registerAcme(acmeProvider({ hostFetch: true }));
    await expect(
      resolveRegistryArtifact('acme', EXACT, {
        fetch: fetchStub({
          [`${ENDPOINT}/artifacts/demo-1.0.0.tar`]: TOOL_TAR.slice(
            0,
            TOOL_TAR.byteLength - 1,
          ),
        }),
      }),
    ).rejects.toMatchObject({ code: 'SIZE_MISMATCH' });
  });

  it('fails closed when the served body exceeds the published size', async () => {
    registerAcme(acmeProvider({ hostFetch: true }));
    const oversized = new Uint8Array(TOOL_TAR.byteLength + 1);
    oversized.set(TOOL_TAR);
    await expect(
      resolveRegistryArtifact('acme', EXACT, {
        fetch: fetchStub({
          [`${ENDPOINT}/artifacts/demo-1.0.0.tar`]: oversized,
        }),
      }),
    ).rejects.toMatchObject({ code: 'SIZE_MISMATCH' });
  });

  it('fails closed when the descriptor publishes no size', async () => {
    registerAcme(acmeProvider({ hostFetch: true, body: { size: undefined } }));
    await expect(
      resolveRegistryArtifact('acme', EXACT, {
        fetch: fetchStub(tarRoute),
      }),
    ).rejects.toMatchObject({ code: 'UNRESOLVABLE' });
  });

  it('fails closed on a plaintext location', async () => {
    for (const uri of [
      'http://acme.fixture.test/artifacts/demo.tar',
      'http://127.0.0.1/artifacts/demo.tar',
    ]) {
      registerAcme(
        acmeProvider({
          hostFetch: true,
          body: { locations: [{ uri }] },
        }),
      );
      let fetched = false;
      await expect(
        resolveRegistryArtifact('acme', EXACT, {
          // SAFETY: The surrounding boundary establishes the asserted domain contract.
          fetch: (async () => {
            fetched = true;
            return new Response(TOOL_TAR);
          }) as typeof fetch,
        }),
      ).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
      expect(fetched).toBe(false);
    }
  });

  it('fails closed on a credentialed location', async () => {
    registerAcme(
      acmeProvider({
        hostFetch: true,
        body: {
          locations: [
            { uri: 'https://user:secret@acme.fixture.test/artifacts/demo.tar' },
          ],
        },
      }),
    );
    let fetched = false;
    try {
      await resolveRegistryArtifact('acme', EXACT, {
        // SAFETY: The surrounding boundary establishes the asserted domain contract.
        fetch: (async () => {
          fetched = true;
          return new Response(TOOL_TAR);
        }) as typeof fetch,
      });
      throw new Error('expected UNSAFE_PATH');
    } catch (error) {
      expect(error).toMatchObject({ code: 'UNSAFE_PATH' });
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      expect((error as Error).message).not.toMatch(/user:secret/u);
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      expect((error as Error).message).not.toMatch(/secret/u);
    }
    expect(fetched).toBe(false);
  });

  it('fails closed on a private or local host-fetch address', async () => {
    for (const origin of [
      'https://127.0.0.1',
      'https://169.254.169.254',
      'https://[::1]',
      'https://[::ffff:127.0.0.1]',
      'https://[64:ff9b::7f00:1]',
    ]) {
      registerAcme(
        acmeProvider({
          hostFetch: true,
          endpoint: origin,
          body: {
            locations: [{ uri: `${origin}/artifacts/demo.tar` }],
          },
        }),
      );
      let fetched = false;
      await expect(
        resolveRegistryArtifact('acme', EXACT, {
          // SAFETY: The surrounding boundary establishes the asserted domain contract.
          fetch: (async () => {
            fetched = true;
            return new Response(TOOL_TAR);
          }) as typeof fetch,
        }),
      ).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
      expect(fetched).toBe(false);
    }
  });

  it('fails closed when a hostname rebinds to a private address', async () => {
    registerAcme(acmeProvider({ hostFetch: true }));
    for (const address of [
      '10.0.0.1',
      '169.254.169.254',
      '::ffff:127.0.0.1',
      '64:ff9b::7f00:1',
    ]) {
      let fetched = false;
      await expect(
        resolveRegistryArtifact('acme', EXACT, {
          // SAFETY: The surrounding boundary establishes the asserted domain contract.
          fetch: (async () => {
            fetched = true;
            return new Response(TOOL_TAR);
          }) as typeof fetch,
          lookup: async () => [
            { address, family: address.includes(':') ? 6 : 4 },
          ],
        }),
      ).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
      expect(fetched).toBe(false);
    }
  });

  it('fails closed when the host-fetch location resolves to no addresses', async () => {
    registerAcme(acmeProvider({ hostFetch: true }));
    let fetched = false;
    await expect(
      resolveRegistryArtifact('acme', EXACT, {
        // SAFETY: The surrounding boundary establishes the asserted domain contract.
        fetch: (async () => {
          fetched = true;
          return new Response(TOOL_TAR);
        }) as typeof fetch,
        lookup: async () => [],
      }),
    ).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    expect(fetched).toBe(false);
  });

  it('fetches a private origin only when the operator pinned it', async () => {
    process.env.OPM_HOST_FETCH_ORIGINS = 'https://acme.fixture.test';
    registerAcme(acmeProvider({ hostFetch: true }));
    const artifact = await resolveRegistryArtifact('acme', EXACT, {
      fetch: fetchStub(tarRoute),
      lookup: async () => [{ address: '10.0.0.1', family: 4 }],
    });
    expect(artifact.bytes).toEqual(TOOL_TAR);
  });

  it('fetches a private IP literal only when the operator pinned that origin', async () => {
    process.env.OPM_HOST_FETCH_ORIGINS = 'https://127.0.0.1';
    registerAcme(
      acmeProvider({
        hostFetch: true,
        endpoint: 'https://127.0.0.1',
        body: {
          locations: [{ uri: 'https://127.0.0.1/artifacts/demo.tar' }],
        },
      }),
    );
    const artifact = await resolveRegistryArtifact('acme', EXACT, {
      fetch: fetchStub({ 'https://127.0.0.1/artifacts/demo.tar': TOOL_TAR }),
    });
    expect(artifact.bytes).toEqual(TOOL_TAR);
  });

  it('refuses a credentialed OPM_HOST_FETCH_ORIGINS pin', async () => {
    process.env.OPM_HOST_FETCH_ORIGINS =
      'https://user:secret@acme.fixture.test';
    registerAcme(acmeProvider({ hostFetch: true }));
    await expect(
      resolveRegistryArtifact('acme', EXACT, {
        fetch: fetchStub(tarRoute),
        lookup: async () => [{ address: '10.0.0.1', family: 4 }],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_ENDPOINT' });
    try {
      await resolveRegistryArtifact('acme', EXACT, {
        fetch: fetchStub(tarRoute),
      });
      throw new Error('expected INVALID_PROVIDER_ENDPOINT');
    } catch (error) {
      expect(error).toMatchObject({ code: 'INVALID_PROVIDER_ENDPOINT' });
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      expect((error as Error).message).not.toMatch(/user:secret/u);
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      expect((error as Error).message).not.toMatch(/secret/u);
    }
  });

  it('fails closed on a location outside the endpoint origin', async () => {
    registerAcme(
      acmeProvider({
        hostFetch: true,
        body: {
          locations: [{ uri: 'https://evil.fixture.test/artifacts/demo.tar' }],
        },
      }),
    );
    let fetched = false;
    await expect(
      resolveRegistryArtifact('acme', EXACT, {
        // SAFETY: The surrounding boundary establishes the asserted domain contract.
        fetch: (async (input: URL | Request | string) => {
          fetched = true;
          return fetchStub({
            'https://evil.fixture.test/artifacts/demo.tar': TOOL_TAR,
          })(input);
        }) as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    expect(fetched).toBe(false);
  });

  const BINDING_DIGEST = `sha256:${'a'.repeat(64)}`;
  function acmeBinding(
    origins: readonly string[],
    id = 'dev.test.acme',
    tokenEnvs?: readonly string[],
    extraHeaders?: {
      names: readonly string[];
      envs: readonly string[];
    },
  ): RegistryOptions['pluginBindings'] {
    return {
      [id]: {
        storeDigest: BINDING_DIGEST,
        artifactOrigins: origins,
        ...(!(tokenEnvs === undefined) && {
          artifactOriginTokenEnvs: tokenEnvs,
        }),
        ...(!(extraHeaders === undefined) && {
          artifactOriginExtraHeaderNames: extraHeaders.names,
          artifactOriginExtraHeaderEnvs: extraHeaders.envs,
        }),
      },
    };
  }

  it('fetches an off-origin location only when the project pinned it', async () => {
    registerAcme(
      acmeProvider({
        hostFetch: true,
        body: {
          locations: [{ uri: 'https://evil.example/artifacts/demo.tar' }],
        },
      }),
    );
    const artifact = await resolveRegistryArtifact('acme', EXACT, {
      fetch: fetchStub({
        'https://evil.example/artifacts/demo.tar': TOOL_TAR,
      }),
      pluginBindings: acmeBinding(['https://evil.example']),
    });
    expect(artifact.bytes).toEqual(TOOL_TAR);
  });

  it('fetches a private IP literal when the project pinned that origin', async () => {
    registerAcme(
      acmeProvider({
        hostFetch: true,
        endpoint: 'https://127.0.0.1',
        body: {
          locations: [{ uri: 'https://127.0.0.1/artifacts/demo.tar' }],
        },
      }),
    );
    const artifact = await resolveRegistryArtifact('acme', EXACT, {
      fetch: fetchStub({ 'https://127.0.0.1/artifacts/demo.tar': TOOL_TAR }),
      pluginBindings: acmeBinding(['https://127.0.0.1']),
    });
    expect(artifact.bytes).toEqual(TOOL_TAR);
  });

  it('unions env pins with the matching plugin artifact_origins', async () => {
    process.env.OPM_HOST_FETCH_ORIGINS = 'https://env.example';
    const bindings = acmeBinding(['https://toml.example']);
    for (const origin of ['https://env.example', 'https://toml.example']) {
      registerAcme(
        acmeProvider({
          hostFetch: true,
          body: {
            locations: [{ uri: `${origin}/artifacts/demo.tar` }],
          },
        }),
      );
      const artifact = await resolveRegistryArtifact('acme', EXACT, {
        fetch: fetchStub({ [`${origin}/artifacts/demo.tar`]: TOOL_TAR }),
        pluginBindings: bindings,
      });
      expect(artifact.bytes).toEqual(TOOL_TAR);
    }
  });

  it('does not apply another plugin binding to this providerId', async () => {
    registerAcme(
      acmeProvider({
        hostFetch: true,
        body: {
          locations: [{ uri: 'https://evil.example/artifacts/demo.tar' }],
        },
      }),
    );
    let fetched = false;
    await expect(
      resolveRegistryArtifact('acme', EXACT, {
        // SAFETY: The surrounding boundary establishes the asserted domain contract.
        fetch: (async () => {
          fetched = true;
          return new Response(TOOL_TAR);
        }) as typeof fetch,
        pluginBindings: acmeBinding(['https://evil.example'], 'dev.test.other'),
      }),
    ).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    expect(fetched).toBe(false);
  });

  it('uses the first location URI and does not walk extra origins', async () => {
    registerAcme(
      acmeProvider({
        hostFetch: true,
        body: {
          locations: [
            { uri: `${ENDPOINT}/artifacts/demo-1.0.0.tar` },
            { uri: 'https://evil.example/artifacts/demo.tar' },
          ],
        },
      }),
    );
    let requested: string[] = [];
    const artifact = await resolveRegistryArtifact('acme', EXACT, {
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      fetch: ((input: URL | Request | string) => {
        requested.push(String(input));
        return fetchStub(tarRoute)(input);
      }) as typeof fetch,
    });
    expect(artifact.bytes).toEqual(TOOL_TAR);
    expect(requested).toEqual([`${ENDPOINT}/artifacts/demo-1.0.0.tar`]);

    registerAcme(
      acmeProvider({
        hostFetch: true,
        body: {
          locations: [
            { uri: 'https://evil.example/artifacts/demo.tar' },
            { uri: `${ENDPOINT}/artifacts/demo-1.0.0.tar` },
          ],
        },
      }),
    );
    requested = [];
    await expect(
      resolveRegistryArtifact('acme', EXACT, {
        // SAFETY: The surrounding boundary establishes the asserted domain contract.
        fetch: ((input: URL | Request | string) => {
          requested.push(String(input));
          return fetchStub(tarRoute)(input);
        }) as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    expect(requested).toEqual([]);
  });

  it('ignores plugin body fields that try to expand pins or attach headers', async () => {
    registerAcme(
      acmeProvider({
        hostFetch: true,
        // SAFETY: The surrounding boundary establishes the asserted domain contract.
        body: {
          locations: [{ uri: 'https://evil.example/artifacts/demo.tar' }],
          headers: { Authorization: 'Bearer stolen' },
          pins: ['https://evil.example'],
          allowedOrigins: ['https://evil.example'],
        } as DescriptorOverrides,
      }),
    );
    let fetched = false;
    await expect(
      resolveRegistryArtifact('acme', EXACT, {
        // SAFETY: The surrounding boundary establishes the asserted domain contract.
        fetch: (async () => {
          fetched = true;
          return new Response(TOOL_TAR);
        }) as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    expect(fetched).toBe(false);
  });

  it('refuses a location URI with query or hash before any GET', async () => {
    for (const uri of [
      `${ENDPOINT}/artifacts/demo.tar?token=secret`,
      `${ENDPOINT}/artifacts/demo.tar#frag`,
    ]) {
      registerAcme(
        acmeProvider({
          hostFetch: true,
          body: { locations: [{ uri }] },
        }),
      );
      let fetched = false;
      await expect(
        resolveRegistryArtifact('acme', EXACT, {
          // SAFETY: The surrounding boundary establishes the asserted domain contract.
          fetch: (async () => {
            fetched = true;
            return new Response(TOOL_TAR);
          }) as typeof fetch,
        }),
      ).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
      expect(fetched).toBe(false);
    }
    registerAcme(
      acmeProvider({
        hostFetch: true,
        body: {
          locations: [{ uri: `${ENDPOINT}/artifacts/demo.tar?token=secret` }],
        },
      }),
    );
    try {
      await resolveRegistryArtifact('acme', EXACT, {
        fetch: fetchStub(tarRoute),
      });
      throw new Error('expected UNSAFE_PATH');
    } catch (error) {
      expect(error).toMatchObject({ code: 'UNSAFE_PATH' });
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      expect((error as Error).message).not.toMatch(/token=secret/u);
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      expect((error as Error).message).not.toMatch(/\?/u);
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      expect((error as Error).message).toContain(
        `${ENDPOINT}/artifacts/demo.tar`,
      );
    }
  });

  it('refuses duplicate OPM_HOST_FETCH_ORIGINS entries', async () => {
    process.env.OPM_HOST_FETCH_ORIGINS =
      'https://acme.fixture.test,https://acme.fixture.test';
    registerAcme(acmeProvider({ hostFetch: true }));
    await expect(
      resolveRegistryArtifact('acme', EXACT, {
        fetch: fetchStub(tarRoute),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_ENDPOINT' });
  });

  function requestHeader(
    init: RequestInit | undefined,
    headerName: string,
  ): string | undefined {
    if (init?.headers === undefined) return undefined;
    const headers = init.headers;
    const lower = headerName.toLowerCase();
    if (headers instanceof Headers) return headers.get(headerName) ?? undefined;
    if (Array.isArray(headers)) {
      const hit = headers.find(([name]) => name.toLowerCase() === lower);
      return hit?.[1];
    }
    for (const [name, value] of Object.entries(
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      headers as Record<string, string>,
    )) {
      if (name.toLowerCase() === lower) return value;
    }
    return undefined;
  }

  function requestAuthorization(init?: RequestInit): string | undefined {
    return requestHeader(init, 'authorization');
  }

  function recordingTarFetch(routes?: Readonly<Record<string, Uint8Array>>) {
    const calls: {
      url: string;
      authorization: string | undefined;
      extra: string | undefined;
    }[] = [];
    const table = routes ?? {};
    return {
      calls,
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({
          url,
          authorization: requestAuthorization(init),
          extra: requestHeader(init, 'X-JFrog-Art-Api'),
        });
        const body = table[url] ?? TOOL_TAR;
        if (table[url] === undefined && Object.keys(table).length > 0)
          return new Response('missing', { status: 404 });
        return new Response(body, {
          status: 200,
          headers: { 'content-type': 'application/octet-stream' },
        });
      }) as typeof fetch,
    };
  }

  function headerBlob(init?: RequestInit): string {
    if (init?.headers === undefined) return '';
    const headers = init.headers;
    if (headers instanceof Headers)
      return [...headers.entries()]
        .map(([name, value]) => `${name}:${value}`)
        .join('\n');
    if (Array.isArray(headers))
      return headers.map(([name, value]) => `${name}:${value}`).join('\n');
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    return Object.entries(headers as Record<string, string>)
      .map(([name, value]) => `${name}:${value}`)
      .join('\n');
  }

  function recordingHonestyFetch() {
    const calls: {
      url: string;
      authorization: string | undefined;
      cookie: string | undefined;
      credentials: RequestCredentials | undefined;
      headers: string;
    }[] = [];
    return {
      calls,
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({
          url,
          authorization: requestAuthorization(init),
          cookie: requestHeader(init, 'cookie'),
          credentials: init?.credentials,
          headers: headerBlob(init),
        });
        const body = tarRoute[url];
        if (body === undefined) return new Response('missing', { status: 404 });
        return new Response(body, {
          status: 200,
          headers: { 'content-type': 'application/octet-stream' },
        });
      }) as typeof fetch,
    };
  }

  async function withTempHome(
    files: Readonly<Record<string, string>>,
    run: (home: string) => Promise<void>,
  ): Promise<void> {
    const home = await mkdtemp(join(tmpdir(), 'opm-host-home-'));
    const previousHome = process.env.HOME;
    const previousProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      for (const [name, contents] of Object.entries(files))
        await writeFile(join(home, name), contents, { mode: 0o600 });
      await run(home);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousProfile;
      await rm(home, { recursive: true, force: true });
    }
  }

  it('suppresses a token when the project names an empty token env', async () => {
    process.env.OPM_HOST_FETCH_ORIGINS = 'https://a.example';
    process.env.OPM_HOST_FETCH_TOKEN_ENVS = 'ACME_TOKEN';
    process.env.ACME_TOKEN = 'tok68value';
    registerAcme(
      acmeProvider({
        hostFetch: true,
        body: { locations: [{ uri: 'https://a.example/artifacts/demo.tar' }] },
      }),
    );
    const { calls, fetch } = recordingTarFetch({
      'https://a.example/artifacts/demo.tar': TOOL_TAR,
    });
    const artifact = await resolveRegistryArtifact('acme', EXACT, {
      fetch,
      pluginBindings: acmeBinding(['https://a.example'], 'dev.test.acme', ['']),
    });
    expect(artifact.bytes).toEqual(TOOL_TAR);
    expect(calls).toEqual([
      {
        url: 'https://a.example/artifacts/demo.tar',
        authorization: undefined,
        extra: undefined,
      },
    ]);
  });

  it('round-trips a suppressing empty token env through parse and serialize', async () => {
    const digest = BINDING_DIGEST;
    const parsed = parseManifest(
      serializeManifest({
        project: { name: 'demo', ecosystems: ['acme'] },
        packages: {},
        plugins: {
          'dev.test.acme': {
            storeDigest: digest,
            artifactOrigins: ['https://a.example'],
            artifactOriginTokenEnvs: [''],
          },
        },
        options: { offline: false, layout: 'opm' },
      }),
    );
    process.env.OPM_HOST_FETCH_ORIGINS = 'https://a.example';
    process.env.OPM_HOST_FETCH_TOKEN_ENVS = 'ACME_TOKEN';
    process.env.ACME_TOKEN = 'tok68value';
    registerAcme(
      acmeProvider({
        hostFetch: true,
        body: { locations: [{ uri: 'https://a.example/artifacts/demo.tar' }] },
      }),
    );
    const { calls, fetch } = recordingTarFetch({
      'https://a.example/artifacts/demo.tar': TOOL_TAR,
    });
    await resolveRegistryArtifact('acme', EXACT, {
      fetch,
      pluginBindings: parsed.plugins,
    });
    expect(calls[0]?.authorization).toBeUndefined();
  });

  it('does not treat OPM_HOST_FETCH_BEARER as a grant unless named', async () => {
    process.env.OPM_HOST_FETCH_ORIGINS = ENDPOINT;
    process.env.OPM_HOST_FETCH_BEARER = 'tok68ambient';
    registerAcme(acmeProvider({ hostFetch: true }));
    const { calls, fetch } = recordingTarFetch(tarRoute);
    const artifact = await resolveRegistryArtifact('acme', EXACT, { fetch });
    expect(artifact.bytes).toEqual(TOOL_TAR);
    expect(calls).toEqual([
      {
        url: `${ENDPOINT}/artifacts/demo-1.0.0.tar`,
        authorization: undefined,
        extra: undefined,
      },
    ]);
  });

  it('does not attach Authorization on a public unpinned endpoint', async () => {
    process.env.ACME_TOKEN = 'tok68value';
    process.env.OPM_HOST_FETCH_BEARER = 'tok68ambient';
    registerAcme(acmeProvider({ hostFetch: true }));
    const { calls, fetch } = recordingTarFetch(tarRoute);
    const artifact = await resolveRegistryArtifact('acme', EXACT, { fetch });
    expect(artifact.bytes).toEqual(TOOL_TAR);
    expect(calls[0]?.authorization).toBeUndefined();
  });

  it('omits Authorization on the second toml origin when its token env is empty', async () => {
    process.env.ACME_A_TOKEN = 'tok68valueA';
    const bindings = acmeBinding(
      ['https://a.example', 'https://b.example'],
      'dev.test.acme',
      ['ACME_A_TOKEN', ''],
    );
    registerAcme(
      acmeProvider({
        hostFetch: true,
        body: { locations: [{ uri: 'https://a.example/artifacts/demo.tar' }] },
      }),
    );
    const first = recordingTarFetch({
      'https://a.example/artifacts/demo.tar': TOOL_TAR,
    });
    await resolveRegistryArtifact('acme', EXACT, {
      fetch: first.fetch,
      pluginBindings: bindings,
    });
    expect(first.calls[0]?.authorization).toBe('Bearer tok68valueA');

    registerAcme(
      acmeProvider({
        hostFetch: true,
        body: { locations: [{ uri: 'https://b.example/artifacts/demo.tar' }] },
      }),
    );
    const second = recordingTarFetch({
      'https://b.example/artifacts/demo.tar': TOOL_TAR,
    });
    await resolveRegistryArtifact('acme', EXACT, {
      fetch: second.fetch,
      pluginBindings: bindings,
    });
    expect(second.calls[0]?.authorization).toBeUndefined();
  });

  it('does not fail a GET to origin A when origin B token is unset', async () => {
    process.env.ACME_A_TOKEN = 'tok68valueA';
    registerAcme(
      acmeProvider({
        hostFetch: true,
        body: { locations: [{ uri: 'https://a.example/artifacts/demo.tar' }] },
      }),
    );
    const { calls, fetch } = recordingTarFetch({
      'https://a.example/artifacts/demo.tar': TOOL_TAR,
    });
    const artifact = await resolveRegistryArtifact('acme', EXACT, {
      fetch,
      pluginBindings: acmeBinding(
        ['https://a.example', 'https://b.example'],
        'dev.test.acme',
        ['ACME_A_TOKEN', 'ACME_B_TOKEN'],
      ),
    });
    expect(artifact.bytes).toEqual(TOOL_TAR);
    expect(calls[0]?.authorization).toBe('Bearer tok68valueA');
  });

  it('sends Authorization on any path of a pinned authed origin', async () => {
    process.env.ACME_TOKEN = 'tok68value';
    registerAcme(
      acmeProvider({
        hostFetch: true,
        body: { locations: [{ uri: 'https://a.example/not-the-artifact' }] },
      }),
    );
    const { calls, fetch } = recordingTarFetch({
      'https://a.example/not-the-artifact': TOOL_TAR,
    });
    await resolveRegistryArtifact('acme', EXACT, {
      fetch,
      pluginBindings: acmeBinding(['https://a.example'], 'dev.test.acme', [
        'ACME_TOKEN',
      ]),
    });
    expect(calls).toEqual([
      {
        url: 'https://a.example/not-the-artifact',
        authorization: 'Bearer tok68value',
        extra: undefined,
      },
    ]);
  });

  it('fails UNRESOLVABLE without fetching an invalid or prefixed token', async () => {
    registerAcme(
      acmeProvider({
        hostFetch: true,
        body: { locations: [{ uri: 'https://a.example/artifacts/demo.tar' }] },
      }),
    );
    const bindings = acmeBinding(['https://a.example'], 'dev.test.acme', [
      'ACME_TOKEN',
    ]);
    for (const value of [
      'tok=en',
      'tok68value\r\ninjected',
      'Bearer tok68value',
    ]) {
      process.env.ACME_TOKEN = value;
      const { calls, fetch } = recordingTarFetch({
        'https://a.example/artifacts/demo.tar': TOOL_TAR,
      });
      try {
        await resolveRegistryArtifact('acme', EXACT, {
          fetch,
          pluginBindings: bindings,
        });
        throw new Error('expected UNRESOLVABLE');
      } catch (error) {
        expect(error).toMatchObject({ code: 'UNRESOLVABLE' });
        expect(error).toBeInstanceOf(OpmError);
        // SAFETY: The surrounding boundary establishes the asserted domain contract.
        expect((error as Error).message).toContain('ACME_TOKEN');
        // SAFETY: The surrounding boundary establishes the asserted domain contract.
        expect((error as Error).message).not.toMatch(/tok68value/u);
        // SAFETY: The surrounding boundary establishes the asserted domain contract.
        expect((error as Error).message).not.toMatch(/tok=en/u);
        // SAFETY: The surrounding boundary establishes the asserted domain contract.
        expect((error as Error).message).not.toMatch(/injected/u);
      }
      expect(calls).toEqual([]);
    }
  });

  it('keeps the artifact uri credential-free after an authed fetch', async () => {
    process.env.ACME_TOKEN = 'tok68value';
    registerAcme(
      acmeProvider({
        hostFetch: true,
        body: { locations: [{ uri: 'https://a.example/artifacts/demo.tar' }] },
      }),
    );
    const artifact = await resolveRegistryArtifact('acme', EXACT, {
      fetch: recordingTarFetch({
        'https://a.example/artifacts/demo.tar': TOOL_TAR,
      }).fetch,
      pluginBindings: acmeBinding(['https://a.example'], 'dev.test.acme', [
        'ACME_TOKEN',
      ]),
    });
    const uri = new URL(artifact.uri);
    expect(uri.username).toBe('');
    expect(uri.password).toBe('');
    expect(uri.search).toBe('');
    expect(uri.hash).toBe('');
    const lock = parseLockfile(
      serializeLockfile({
        schemaVersion: 1,
        generatedBy: 'opm',
        packages: {
          demo: {
            alias: 'demo',
            purl: EXACT,
            version: '1.0.0',
            digest: `sha256:${TOOL_DIGEST}`,
            size: TOOL_TAR.byteLength,
            format: 'tar',
            mediaType: 'application/x-tar',
            source: artifact.uri,
            storeKey: `sha256-${TOOL_DIGEST}`,
            bins: [],
            reason: 'direct',
            ecosystem: 'acme',
          },
        },
      }),
    );
    const source = new URL(lock.packages['demo']!.source);
    expect(source.username).toBe('');
    expect(source.password).toBe('');
    expect(source.search).toBe('');
    expect(source.hash).toBe('');
  });

  it('refuses TOKEN_ENVS arity mismatch and invalid names', async () => {
    process.env.OPM_HOST_FETCH_ORIGINS = 'https://a.example';
    process.env.OPM_HOST_FETCH_TOKEN_ENVS = 'ACME_A_TOKEN,';
    registerAcme(
      acmeProvider({
        hostFetch: true,
        body: { locations: [{ uri: 'https://a.example/artifacts/demo.tar' }] },
      }),
    );
    await expect(
      resolveRegistryArtifact('acme', EXACT, {
        fetch: fetchStub({
          'https://a.example/artifacts/demo.tar': TOOL_TAR,
        }),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_ENDPOINT' });

    process.env.OPM_HOST_FETCH_TOKEN_ENVS = 'acme_token';
    await expect(
      resolveRegistryArtifact('acme', EXACT, {
        fetch: fetchStub({
          'https://a.example/artifacts/demo.tar': TOOL_TAR,
        }),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_ENDPOINT' });
  });

  it('attaches an env-only pin bearer when TOKEN_ENVS names the var', async () => {
    process.env.OPM_HOST_FETCH_ORIGINS = 'https://a.example';
    process.env.OPM_HOST_FETCH_TOKEN_ENVS = 'ACME_TOKEN';
    process.env.ACME_TOKEN = 'tok68value';
    registerAcme(
      acmeProvider({
        hostFetch: true,
        body: { locations: [{ uri: 'https://a.example/artifacts/demo.tar' }] },
      }),
    );
    const { calls, fetch } = recordingTarFetch({
      'https://a.example/artifacts/demo.tar': TOOL_TAR,
    });
    await resolveRegistryArtifact('acme', EXACT, { fetch });
    expect(calls[0]?.authorization).toBe('Bearer tok68value');
  });

  it('attaches an extra header only on a pinned origin', async () => {
    process.env.JFROG_API_KEY = 'jfrog-key';
    registerAcme(
      acmeProvider({
        hostFetch: true,
        body: { locations: [{ uri: 'https://a.example/artifacts/demo.tar' }] },
      }),
    );
    const pinned = recordingTarFetch({
      'https://a.example/artifacts/demo.tar': TOOL_TAR,
    });
    await resolveRegistryArtifact('acme', EXACT, {
      fetch: pinned.fetch,
      pluginBindings: acmeBinding(
        ['https://a.example'],
        'dev.test.acme',
        undefined,
        { names: ['X-JFrog-Art-Api'], envs: ['JFROG_API_KEY'] },
      ),
    });
    expect(pinned.calls).toEqual([
      {
        url: 'https://a.example/artifacts/demo.tar',
        authorization: undefined,
        extra: 'jfrog-key',
      },
    ]);

    registerAcme(acmeProvider({ hostFetch: true }));
    const unpinned = recordingTarFetch(tarRoute);
    await resolveRegistryArtifact('acme', EXACT, {
      fetch: unpinned.fetch,
      pluginBindings: acmeBinding(
        ['https://a.example'],
        'dev.test.acme',
        undefined,
        { names: ['X-JFrog-Art-Api'], envs: ['JFROG_API_KEY'] },
      ),
    });
    expect(unpinned.calls[0]?.extra).toBeUndefined();
  });

  it('attaches Bearer and extra header independently on one origin', async () => {
    process.env.ACME_TOKEN = 'tok68value';
    process.env.JFROG_API_KEY = 'jfrog-key';
    registerAcme(
      acmeProvider({
        hostFetch: true,
        body: { locations: [{ uri: 'https://a.example/artifacts/demo.tar' }] },
      }),
    );
    const { calls, fetch } = recordingTarFetch({
      'https://a.example/artifacts/demo.tar': TOOL_TAR,
    });
    await resolveRegistryArtifact('acme', EXACT, {
      fetch,
      pluginBindings: acmeBinding(
        ['https://a.example'],
        'dev.test.acme',
        ['ACME_TOKEN'],
        { names: ['X-JFrog-Art-Api'], envs: ['JFROG_API_KEY'] },
      ),
    });
    expect(calls).toEqual([
      {
        url: 'https://a.example/artifacts/demo.tar',
        authorization: 'Bearer tok68value',
        extra: 'jfrog-key',
      },
    ]);
  });

  it('suppresses an extra header when the project names an empty header name', async () => {
    process.env.OPM_HOST_FETCH_ORIGINS = 'https://a.example';
    process.env.OPM_HOST_FETCH_HEADER_NAMES = 'X-JFrog-Art-Api';
    process.env.OPM_HOST_FETCH_HEADER_ENVS = 'JFROG_API_KEY';
    process.env.JFROG_API_KEY = 'jfrog-key';
    registerAcme(
      acmeProvider({
        hostFetch: true,
        body: { locations: [{ uri: 'https://a.example/artifacts/demo.tar' }] },
      }),
    );
    const { calls, fetch } = recordingTarFetch({
      'https://a.example/artifacts/demo.tar': TOOL_TAR,
    });
    await resolveRegistryArtifact('acme', EXACT, {
      fetch,
      pluginBindings: acmeBinding(
        ['https://a.example'],
        'dev.test.acme',
        undefined,
        { names: [''], envs: [''] },
      ),
    });
    expect(calls[0]?.extra).toBeUndefined();
  });

  it('round-trips a suppressing empty extra-header name through parse and serialize', async () => {
    const parsed = parseManifest(
      serializeManifest({
        project: { name: 'demo', ecosystems: ['acme'] },
        packages: {},
        plugins: {
          'dev.test.acme': {
            storeDigest: BINDING_DIGEST,
            artifactOrigins: ['https://a.example'],
            artifactOriginExtraHeaderNames: [''],
            artifactOriginExtraHeaderEnvs: [''],
          },
        },
        options: { offline: false, layout: 'opm' },
      }),
    );
    process.env.OPM_HOST_FETCH_ORIGINS = 'https://a.example';
    process.env.OPM_HOST_FETCH_HEADER_NAMES = 'X-JFrog-Art-Api';
    process.env.OPM_HOST_FETCH_HEADER_ENVS = 'JFROG_API_KEY';
    process.env.JFROG_API_KEY = 'jfrog-key';
    registerAcme(
      acmeProvider({
        hostFetch: true,
        body: { locations: [{ uri: 'https://a.example/artifacts/demo.tar' }] },
      }),
    );
    const { calls, fetch } = recordingTarFetch({
      'https://a.example/artifacts/demo.tar': TOOL_TAR,
    });
    await resolveRegistryArtifact('acme', EXACT, {
      fetch,
      pluginBindings: parsed.plugins,
    });
    expect(calls[0]?.extra).toBeUndefined();
  });

  it('does not fail a GET to origin A when origin B extra-header env is unset', async () => {
    process.env.JFROG_A_KEY = 'key-a';
    registerAcme(
      acmeProvider({
        hostFetch: true,
        body: { locations: [{ uri: 'https://a.example/artifacts/demo.tar' }] },
      }),
    );
    const { calls, fetch } = recordingTarFetch({
      'https://a.example/artifacts/demo.tar': TOOL_TAR,
    });
    const artifact = await resolveRegistryArtifact('acme', EXACT, {
      fetch,
      pluginBindings: acmeBinding(
        ['https://a.example', 'https://b.example'],
        'dev.test.acme',
        undefined,
        {
          names: ['X-JFrog-Art-Api', 'X-JFrog-Art-Api'],
          envs: ['JFROG_A_KEY', 'JFROG_B_KEY'],
        },
      ),
    });
    expect(artifact.bytes).toEqual(TOOL_TAR);
    expect(calls[0]?.extra).toBe('key-a');
  });

  it('fails UNRESOLVABLE without fetching CR or LF in the extra-header value', async () => {
    registerAcme(
      acmeProvider({
        hostFetch: true,
        body: { locations: [{ uri: 'https://a.example/artifacts/demo.tar' }] },
      }),
    );
    const bindings = acmeBinding(
      ['https://a.example'],
      'dev.test.acme',
      undefined,
      { names: ['X-JFrog-Art-Api'], envs: ['JFROG_API_KEY'] },
    );
    for (const value of ['bad\rvalue', 'bad\nvalue']) {
      process.env.JFROG_API_KEY = value;
      const { calls, fetch } = recordingTarFetch({
        'https://a.example/artifacts/demo.tar': TOOL_TAR,
      });
      try {
        await resolveRegistryArtifact('acme', EXACT, {
          fetch,
          pluginBindings: bindings,
        });
        throw new Error('expected UNRESOLVABLE');
      } catch (error) {
        expect(error).toMatchObject({ code: 'UNRESOLVABLE' });
        expect(error).toBeInstanceOf(OpmError);
        // SAFETY: The surrounding boundary establishes the asserted domain contract.
        expect((error as Error).message).toContain('JFROG_API_KEY');
        // SAFETY: The surrounding boundary establishes the asserted domain contract.
        expect((error as Error).message).not.toMatch(/bad/u);
      }
      expect(calls).toEqual([]);
    }
  });

  it('refuses extra-header env names Cookie, Authorization, and Host at parse', async () => {
    process.env.OPM_HOST_FETCH_ORIGINS = 'https://a.example';
    process.env.OPM_HOST_FETCH_HEADER_ENVS = 'JFROG_API_KEY';
    process.env.JFROG_API_KEY = 'jfrog-key';
    registerAcme(
      acmeProvider({
        hostFetch: true,
        body: { locations: [{ uri: 'https://a.example/artifacts/demo.tar' }] },
      }),
    );
    for (const name of ['Cookie', 'Authorization', 'Host']) {
      process.env.OPM_HOST_FETCH_HEADER_NAMES = name;
      let fetched = false;
      await expect(
        resolveRegistryArtifact('acme', EXACT, {
          // SAFETY: The surrounding boundary establishes the asserted domain contract.
          fetch: (async () => {
            fetched = true;
            return new Response(TOOL_TAR);
          }) as typeof fetch,
        }),
      ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_ENDPOINT' });
      expect(fetched).toBe(false);
    }
  });

  it('refuses HEADER_NAMES arity mismatch', async () => {
    process.env.OPM_HOST_FETCH_ORIGINS = 'https://a.example';
    process.env.OPM_HOST_FETCH_HEADER_NAMES = 'X-JFrog-Art-Api,';
    process.env.OPM_HOST_FETCH_HEADER_ENVS = 'JFROG_API_KEY';
    registerAcme(
      acmeProvider({
        hostFetch: true,
        body: { locations: [{ uri: 'https://a.example/artifacts/demo.tar' }] },
      }),
    );
    await expect(
      resolveRegistryArtifact('acme', EXACT, {
        fetch: fetchStub({
          'https://a.example/artifacts/demo.tar': TOOL_TAR,
        }),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_ENDPOINT' });
  });

  it('attaches an env-only extra header when HEADER_NAMES names the header', async () => {
    process.env.OPM_HOST_FETCH_ORIGINS = 'https://a.example';
    process.env.OPM_HOST_FETCH_HEADER_NAMES = 'X-JFrog-Art-Api';
    process.env.OPM_HOST_FETCH_HEADER_ENVS = 'JFROG_API_KEY';
    process.env.JFROG_API_KEY = 'jfrog-key';
    registerAcme(
      acmeProvider({
        hostFetch: true,
        body: { locations: [{ uri: 'https://a.example/artifacts/demo.tar' }] },
      }),
    );
    const { calls, fetch } = recordingTarFetch({
      'https://a.example/artifacts/demo.tar': TOOL_TAR,
    });
    await resolveRegistryArtifact('acme', EXACT, { fetch });
    expect(calls[0]?.extra).toBe('jfrog-key');
  });

  it('does not inherit Authorization from ~/.netrc', async () => {
    await withTempHome(
      {
        '.netrc': 'machine acme.fixture.test login user password s3cretnetrc\n',
      },
      async (home) => {
        await chmod(join(home, '.netrc'), 0o000);
        registerAcme(acmeProvider({ hostFetch: true }));
        const { calls, fetch } = recordingHonestyFetch();
        const artifact = await resolveRegistryArtifact('acme', EXACT, {
          fetch,
        });
        expect(artifact.bytes).toEqual(TOOL_TAR);
        expect(calls).toHaveLength(1);
        expect(calls[0]!.url).toBe(ARTIFACT_URL);
        expect(calls[0]!.authorization).toBeUndefined();
        expect(calls[0]!.cookie).toBeUndefined();
        expect(calls[0]!.credentials).not.toBe('include');
        expect(JSON.stringify(calls)).not.toMatch(/s3cretnetrc/u);
        expect(calls[0]!.headers).not.toMatch(/s3cretnetrc/u);
      },
    );
  });

  it('does not inherit Authorization from ~/.npmrc', async () => {
    await withTempHome(
      {
        '.npmrc': '//acme.fixture.test/:_authToken=s3cretnpmrc\n',
      },
      async (home) => {
        await chmod(join(home, '.npmrc'), 0o000);
        registerAcme(acmeProvider({ hostFetch: true }));
        const { calls, fetch } = recordingHonestyFetch();
        const artifact = await resolveRegistryArtifact('acme', EXACT, {
          fetch,
        });
        expect(artifact.bytes).toEqual(TOOL_TAR);
        expect(calls).toHaveLength(1);
        expect(calls[0]!.url).toBe(ARTIFACT_URL);
        expect(calls[0]!.authorization).toBeUndefined();
        expect(calls[0]!.cookie).toBeUndefined();
        expect(calls[0]!.credentials).not.toBe('include');
        expect(JSON.stringify(calls)).not.toMatch(/s3cretnpmrc/u);
        expect(calls[0]!.headers).not.toMatch(/s3cretnpmrc/u);
      },
    );
  });

  it('does not send credentials include or Cookie on host-fetch', async () => {
    registerAcme(acmeProvider({ hostFetch: true }));
    const { calls, fetch } = recordingHonestyFetch();
    const artifact = await resolveRegistryArtifact('acme', EXACT, { fetch });
    expect(artifact.bytes).toEqual(TOOL_TAR);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(ARTIFACT_URL);
    expect(calls[0]!.credentials).not.toBe('include');
    expect(calls[0]!.cookie).toBeUndefined();
    expect(calls[0]!.authorization).toBeUndefined();
    expect(calls[0]!.headers).not.toMatch(/cookie/iu);
  });

  it('does not fetch IMDS as a credential oracle', async () => {
    registerAcme(acmeProvider({ hostFetch: true }));
    const lookedUp: string[] = [];
    const { calls, fetch } = recordingHonestyFetch();
    const artifact = await resolveRegistryArtifact('acme', EXACT, {
      fetch,
      lookup: async (hostname) => {
        lookedUp.push(hostname);
        return [{ address: '1.1.1.1', family: 4 }];
      },
    });
    expect(artifact.bytes).toEqual(TOOL_TAR);
    expect(calls.map((call) => call.url)).toEqual([ARTIFACT_URL]);
    expect(lookedUp).toEqual(['acme.fixture.test']);
    const blob = `${calls.map((call) => call.url).join('\n')}\n${lookedUp.join('\n')}`;
    expect(blob).not.toMatch(/169\.254\.169\.254/u);
    expect(blob).not.toMatch(/metadata\.google\.internal/u);
    expect(blob).not.toMatch(/fd00:ec2::254/u);
    expect(calls[0]!.credentials).not.toBe('include');
    expect(calls[0]!.cookie).toBeUndefined();
    expect(calls[0]!.authorization).toBeUndefined();
  });

  it('keeps rawBody behavior when the provider does not ask for host-fetch', async () => {
    const provider = acmeProvider({ hostFetch: false });
    registerAcme(provider);
    let fetched = false;
    const artifact = await resolveRegistryArtifact('acme', EXACT, {
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      fetch: (() => {
        fetched = true;
        return fetchStub(tarRoute)('');
      }) as typeof fetch,
    });
    const record = await provider.fetchArtifactRecord(EXACT);
    expect(artifact.bytes).toEqual(record.rawBody);
    expect(artifact.bytes).not.toEqual(TOOL_TAR);
    expect(fetched).toBe(false);
  });
});

describe('delegated bins flow', () => {
  let artifactServer: AcmeArtifactFixtureServer;

  beforeAll(async () => {
    artifactServer = await startAcmeArtifactFixtureServer({
      artifactPath: '/artifacts/demo-1.0.0.tar',
      body: TOOL_TAR,
    });
  });

  beforeEach(() => {
    process.env.OPM_HOST_FETCH_ORIGINS = artifactServer.origin;
  });

  afterAll(async () => {
    await artifactServer.close();
  });

  it('pins provider executables into the materialized tool cache', async () => {
    registerAcme(
      acmeProvider({
        hostFetch: true,
        endpoint: artifactServer.origin,
        body: {
          locations: [{ uri: artifactServer.artifactUrl }],
        },
        executables: [
          { name: 'demo', path: 'bin/demo', interpreter: 'native' },
        ],
      }),
    );
    const cacheRoot = await mkdtemp(join(tmpdir(), 'opm-host-fetch-'));
    try {
      const tool = await fetchTool({
        purl: EXACT,
        cacheRoot,
        registryOptions: { fetch: artifactServer.fetch },
      });
      expect(tool.bins).toEqual([
        { name: 'demo', path: 'bin/demo', interpreter: 'native' },
      ]);
      // Extraction kept the archive's exec bit, or native cannot run.
      const target = join(tool.storePath, 'bin', 'demo');
      expect((await stat(target)).mode & 0o111).not.toBe(0);
      expect(await readFile(target, 'utf8')).toBe(TOOL_SCRIPT);
    } finally {
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });

  // binDeclarationsFromExecutables re-asserts the safety invariants locally
  // rather than inheriting them from whoever produced the declarations.
  it('refuses provider executables whose path escapes the store', () => {
    for (const path of ['../evil', '/bin/evil', 'bin\\evil', 'C:/evil', '']) {
      expect(() =>
        binDeclarationsFromExecutables([{ name: 'demo', path }]),
      ).toThrowError(expect.objectContaining({ code: 'UNSAFE_BIN' }));
    }
    expect(() =>
      binDeclarationsFromExecutables([{ name: 'a/b', path: 'bin/demo' }]),
    ).toThrow();
    expect(
      binDeclarationsFromExecutables([
        { name: 'demo', path: 'bin/demo', interpreter: 'native' },
      ]),
    ).toEqual([{ name: 'demo', path: 'bin/demo', interpreter: 'native' }]);
  });
});

describe('ephemeral tool cache', () => {
  const EXECUTABLES = [
    { name: 'demo', path: 'bin/demo', interpreter: 'native' as const },
  ];

  let artifactServer: AcmeArtifactFixtureServer;

  beforeAll(async () => {
    artifactServer = await startAcmeArtifactFixtureServer({
      artifactPath: '/artifacts/demo-1.0.0.tar',
      body: TOOL_TAR,
    });
  });

  beforeEach(() => {
    process.env.OPM_HOST_FETCH_ORIGINS = artifactServer.origin;
  });

  afterAll(async () => {
    await artifactServer.close();
  });

  function registerAcmeOnServer(
    input: Parameters<typeof acmeProvider>[0],
    wrap?: (provider: CatalogProvider) => CatalogProvider,
  ): void {
    const provider = acmeProvider({
      ...input,
      endpoint: artifactServer.origin,
      body: {
        locations: [{ uri: artifactServer.artifactUrl }],
        ...input.body,
      },
    });
    registerAcme(wrap ? wrap(provider) : provider);
  }

  function serverDescriptor(overrides: DescriptorOverrides = {}) {
    return descriptor({
      ...overrides,
      locations: overrides.locations ?? [{ uri: artifactServer.artifactUrl }],
    });
  }

  /** Count provider calls so a test can prove what is re-resolved per run. */
  function counted(
    provider: CatalogProvider,
    counts: { inspect: number; record: number },
  ): CatalogProvider {
    return {
      ...provider,
      async inspect(...args) {
        counts.inspect += 1;
        return provider.inspect(...args);
      },
      async fetchArtifactRecord(...args) {
        counts.record += 1;
        return provider.fetchArtifactRecord(...args);
      },
    };
  }

  /**
   * Serve the byte downloads and count them. The run takes it as its `fetch`:
   * production dials a pinned address, which a stubbed global never sees.
   */
  function countingFetch(routes: Readonly<Record<string, Uint8Array>>) {
    let count = 0;
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const fetch = ((input: URL | Request | string) => {
      count += 1;
      return fetchStub(routes)(input);
    }) as typeof fetch;
    return { fetch, downloads: () => count };
  }

  function countingArtifactFetch(extra?: Readonly<Record<string, Uint8Array>>) {
    return countingFetch({
      [artifactServer.artifactUrl]: TOOL_TAR,
      ...extra,
    });
  }

  /** One ephemeral run of the acme tool over a counted network. */
  const run = (net: ReturnType<typeof countingFetch>, cacheRoot: string) =>
    fetchTool({
      purl: EXACT,
      cacheRoot,
      registryOptions: { fetch: net.fetch },
    });

  it('serves a repeat run from the cache without re-downloading bytes', async () => {
    const counts = { inspect: 0, record: 0 };
    registerAcmeOnServer({ hostFetch: true, executables: EXECUTABLES }, (p) =>
      counted(p, counts),
    );
    const fetch_ = countingArtifactFetch();
    const cacheRoot = await mkdtemp(join(tmpdir(), 'opm-cache-'));
    try {
      const first = await run(fetch_, cacheRoot);
      expect(first.cached).toBe(false);
      expect(fetch_.downloads()).toBe(1);
      const afterFirst = { ...counts };

      const second = await run(fetch_, cacheRoot);
      expect(second.cached).toBe(true);
      expect(second.storePath).toBe(first.storePath);
      expect(second.bins).toEqual(first.bins);
      // The byte download is the only traffic a cache hit skips...
      expect(fetch_.downloads()).toBe(1);
      // ...resolution metadata is re-read on every run: an unpinned purl is a
      // different thing tomorrow, and the cache is keyed by what the registry
      // says today.
      expect(counts.inspect).toBeGreaterThan(afterFirst.inspect);
      expect(counts.record).toBeGreaterThan(afterFirst.record);
      // The rebuilt tree is the verified one.
      expect(
        await readFile(join(second.storePath, 'bin', 'demo'), 'utf8'),
      ).toBe(TOOL_SCRIPT);
    } finally {
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });

  it('downloads again when the registry re-pins the digest', async () => {
    // Resolution is never cached: a record that suddenly names different bytes
    // is a cache miss for the new digest, not a hit for the old one.
    const otherTar = tarEntry(
      'bin/demo',
      new TextEncoder().encode('#!/bin/sh\necho acme-tool-v2\n'),
      0o755,
    );
    const routes: Record<string, Uint8Array> = {
      [artifactServer.artifactUrl]: TOOL_TAR,
    };
    let served = serverDescriptor();
    const base = acmeProvider({
      hostFetch: true,
      executables: EXECUTABLES,
      endpoint: artifactServer.origin,
      body: { locations: [{ uri: artifactServer.artifactUrl }] },
    });
    const shifting: CatalogProvider = {
      ...base,
      async fetchArtifactRecord() {
        return {
          key: EXACT,
          endpoint: artifactServer.origin,
          body: served,
          rawBody: new TextEncoder().encode(JSON.stringify(served)),
          retrievedAt: '2020-01-01T00:00:00Z',
        };
      },
    };
    registerAcme(shifting);
    const fetch_ = countingFetch(routes);
    const cacheRoot = await mkdtemp(join(tmpdir(), 'opm-cache-'));
    try {
      const first = await run(fetch_, cacheRoot);
      expect(first.digest).toBe(`sha256:${TOOL_DIGEST}`);

      served = serverDescriptor({
        digest: { algorithm: 'sha256', value: sha256(otherTar) },
        size: otherTar.byteLength,
      });
      routes[artifactServer.artifactUrl] = otherTar;

      const second = await run(fetch_, cacheRoot);
      expect(second.cached).toBe(false);
      expect(second.digest).toBe(`sha256:${sha256(otherTar)}`);
      expect(second.storePath).not.toBe(first.storePath);
      expect(fetch_.downloads()).toBe(2);
    } finally {
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });

  it('rebuilds a tampered store tree from the verified archive, offline of the network', async () => {
    registerAcmeOnServer({ hostFetch: true, executables: EXECUTABLES });
    const fetch_ = countingArtifactFetch();
    const cacheRoot = await mkdtemp(join(tmpdir(), 'opm-cache-'));
    try {
      const first = await run(fetch_, cacheRoot);
      const target = join(first.storePath, 'bin', 'demo');
      await writeFile(target, 'tampered');

      const second = await run(fetch_, cacheRoot);
      expect(second.cached).toBe(true);
      expect(fetch_.downloads()).toBe(1);
      expect(await readFile(target, 'utf8')).toBe(TOOL_SCRIPT);
    } finally {
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });

  it('falls through to download and verify when the cache entry is corrupt, and self-heals', async () => {
    registerAcmeOnServer({ hostFetch: true, executables: EXECUTABLES });
    const fetch_ = countingArtifactFetch();
    const cacheRoot = await mkdtemp(join(tmpdir(), 'opm-cache-'));
    try {
      const first = await run(fetch_, cacheRoot);
      // Same length, different bytes: only the digest check can catch it.
      const archive = `${first.storePath}.artifact`;
      await chmod(archive, 0o644);
      await writeFile(
        archive,
        TOOL_TAR.map((byte) => byte ^ 0xff),
      );

      // The corrupt entry must not make a runnable tool fail: the run falls
      // back to the bounded download and verifies as if uncached.
      const second = await run(fetch_, cacheRoot);
      expect(second.cached).toBe(false);
      expect(fetch_.downloads()).toBe(2);
      expect(
        await readFile(join(second.storePath, 'bin', 'demo'), 'utf8'),
      ).toBe(TOOL_SCRIPT);

      // Self-healed: the archive now holds the verified bytes again.
      const third = await run(fetch_, cacheRoot);
      expect(third.cached).toBe(true);
      expect(fetch_.downloads()).toBe(2);
    } finally {
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });

  it('re-downloads when the archive is gone but the tree survived', async () => {
    registerAcmeOnServer({ hostFetch: true, executables: EXECUTABLES });
    const fetch_ = countingArtifactFetch();
    const cacheRoot = await mkdtemp(join(tmpdir(), 'opm-cache-'));
    try {
      const first = await run(fetch_, cacheRoot);
      await rm(`${first.storePath}.artifact`, { force: true });

      // The tree alone is not a trusted cache entry — nothing re-verified it
      // against the digest — so the bytes move again.
      const second = await run(fetch_, cacheRoot);
      expect(second.cached).toBe(false);
      expect(fetch_.downloads()).toBe(2);
      expect(
        await readFile(join(second.storePath, 'bin', 'demo'), 'utf8'),
      ).toBe(TOOL_SCRIPT);
    } finally {
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });
});

describe('native interpreter', () => {
  it('generates a shim whose ambient body spawns the store file directly', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opm-native-shim-'));
    try {
      const written = await writeBinShims({
        binDir: join(root, 'bin'),
        storeRoot: join(root, 'store'),
        bins: [{ name: 'demo', path: 'bin/demo', interpreter: 'native' }],
      });
      expect(written).toHaveLength(1);
      expect(written[0]!.interpreter).toBe('native');
      const shim = await readFile(written[0]!.shim, 'utf8');
      expect(shim).toContain('spawn(target, process.argv.slice(2)');
      expect(shim).not.toContain('process.execPath, [target');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('runs a store-resident native tool through the package sandbox', async () => {
    // The package-exec profile executes interpreters from the host toolchain;
    // this proves a verified store file gets the same treatment. Skipped where
    // no enforcing backend exists.
    if (
      process.platform !== 'linux' ||
      findTrustedSandboxHelper('bwrap') === undefined
    )
      return;
    registerAcme(
      acmeProvider({
        hostFetch: true,
        executables: [
          { name: 'demo', path: 'bin/demo', interpreter: 'native' },
        ],
      }),
    );
    const cacheRoot = await mkdtemp(join(tmpdir(), 'opm-native-run-'));
    try {
      const tool = await fetchTool({
        purl: EXACT,
        cacheRoot,
        fetch: fetchStub(tarRoute),
      });
      const target = join(tool.storePath, 'bin', 'demo');
      const outcome = await runSandboxedPackageProcess({
        argv: [target, 'hello'],
        cwd: tool.storePath,
        storePaths: [tool.storePath],
      });
      expect(outcome.exitCode).toBe(0);
      expect(outcome.enforced).toBe(true);
      expect(outcome.stdout).toBe('acme-tool-ok hello\n');
    } finally {
      await rm(cacheRoot, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('lockfile bin round-trip', () => {
  const pkg: LockPackage = {
    alias: 'demo',
    purl: EXACT,
    version: '1.0.0',
    digest: `sha256:${TOOL_DIGEST}`,
    size: TOOL_TAR.byteLength,
    format: 'tar',
    mediaType: 'application/x-tar',
    source: `${ENDPOINT}/artifacts/demo-1.0.0.tar`,
    storeKey: `sha256-${TOOL_DIGEST}`,
    bins: [
      { name: 'demo', path: 'bin/demo', interpreter: 'native' },
      {
        name: 'demo-py',
        path: 'bin/demo.py',
        interpreter: 'python',
        entry: 'demo.cli:main',
      },
    ],
    reason: 'direct',
    ecosystem: 'acme',
  };

  it('keeps interpreter and entry through serialize/parse', () => {
    const lock = parseLockfile(
      serializeLockfile({
        schemaVersion: 1,
        generatedBy: 'opm',
        packages: { demo: pkg },
      }),
    );
    expect(lock.packages['demo']!.bins).toEqual(pkg.bins);
  });

  it('refuses an interpreter it does not know', () => {
    const text = serializeLockfile({
      schemaVersion: 1,
      generatedBy: 'opm',
      packages: { demo: pkg },
    }).replace('"native"', '"ruby"');
    expect(() => parseLockfile(text)).toThrow(/invalid interpreter/u);
  });
});
