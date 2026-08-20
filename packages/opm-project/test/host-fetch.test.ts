import { afterEach, describe, expect, it, vi } from 'vitest';
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
  parseLockfile,
  requireAdapterRegistry,
  resolveRegistryArtifact,
  runSandboxedPackageProcess,
  serializeLockfile,
  writeBinShims,
  type AdapterModule,
  type LockPackage,
} from '../src/index.js';

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
} as unknown as PackageInstance;

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
}): CatalogProvider {
  const recordBody = descriptor(input.body);
  const record: ProviderRecord = {
    key: EXACT,
    endpoint: ENDPOINT,
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
    ...(input.executables === undefined
      ? {}
      : { executables: input.executables }),
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('delegated host-fetch acquisition', () => {
  it('downloads, bounds, and verifies the bytes itself', async () => {
    registerAcme(acmeProvider({ hostFetch: true }));
    let requested: string[] = [];
    const artifact = await resolveRegistryArtifact('acme', EXACT, {
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
    registerAcme(
      acmeProvider({
        hostFetch: true,
        body: {
          locations: [{ uri: 'http://acme.fixture.test/artifacts/demo.tar' }],
        },
      }),
    );
    await expect(
      resolveRegistryArtifact('acme', EXACT, {
        fetch: fetchStub(tarRoute),
      }),
    ).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
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
    await expect(
      resolveRegistryArtifact('acme', EXACT, {
        fetch: fetchStub(tarRoute),
      }),
    ).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
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
    await expect(
      resolveRegistryArtifact('acme', EXACT, {
        fetch: fetchStub({
          'https://evil.fixture.test/artifacts/demo.tar': TOOL_TAR,
        }),
      }),
    ).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
  });

  it('keeps rawBody behavior when the provider does not ask for host-fetch', async () => {
    const provider = acmeProvider({ hostFetch: false });
    registerAcme(provider);
    let fetched = false;
    const artifact = await resolveRegistryArtifact('acme', EXACT, {
      fetch: (() => {
        fetched = true;
        return fetchStub(tarRoute)('');
      }) as unknown as typeof fetch,
    });
    const record = await provider.fetchArtifactRecord(EXACT);
    expect(artifact.bytes).toEqual(record.rawBody);
    expect(artifact.bytes).not.toEqual(TOOL_TAR);
    expect(fetched).toBe(false);
  });
});

describe('delegated bins flow', () => {
  it('pins provider executables into the materialized tool cache', async () => {
    registerAcme(
      acmeProvider({
        hostFetch: true,
        executables: [
          { name: 'demo', path: 'bin/demo', interpreter: 'native' },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchStub(tarRoute));
    const cacheRoot = await mkdtemp(join(tmpdir(), 'opm-host-fetch-'));
    try {
      const tool = await fetchTool({
        purl: EXACT,
        cacheRoot,
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

  /** Count host-side byte downloads; the only global-fetch user on this path. */
  function countingFetch(routes: Readonly<Record<string, Uint8Array>>): {
    downloads: () => number;
  } {
    let count = 0;
    vi.stubGlobal('fetch', ((input: URL | Request | string) => {
      count += 1;
      return fetchStub(routes)(input);
    }) as typeof fetch);
    return { downloads: () => count };
  }

  it('serves a repeat run from the cache without re-downloading bytes', async () => {
    const counts = { inspect: 0, record: 0 };
    registerAcme(
      counted(
        acmeProvider({ hostFetch: true, executables: EXECUTABLES }),
        counts,
      ),
    );
    const fetch_ = countingFetch(tarRoute);
    const cacheRoot = await mkdtemp(join(tmpdir(), 'opm-cache-'));
    try {
      const first = await fetchTool({ purl: EXACT, cacheRoot });
      expect(first.cached).toBe(false);
      expect(fetch_.downloads()).toBe(1);
      const afterFirst = { ...counts };

      const second = await fetchTool({ purl: EXACT, cacheRoot });
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
    const routes: Record<string, Uint8Array> = { ...tarRoute };
    let served = descriptor();
    const base = acmeProvider({ hostFetch: true, executables: EXECUTABLES });
    const shifting: CatalogProvider = {
      ...base,
      async fetchArtifactRecord() {
        return {
          key: EXACT,
          endpoint: ENDPOINT,
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
      const first = await fetchTool({ purl: EXACT, cacheRoot });
      expect(first.digest).toBe(`sha256:${TOOL_DIGEST}`);

      served = descriptor({
        digest: { algorithm: 'sha256', value: sha256(otherTar) },
        size: otherTar.byteLength,
      });
      routes[`${ENDPOINT}/artifacts/demo-1.0.0.tar`] = otherTar;

      const second = await fetchTool({ purl: EXACT, cacheRoot });
      expect(second.cached).toBe(false);
      expect(second.digest).toBe(`sha256:${sha256(otherTar)}`);
      expect(second.storePath).not.toBe(first.storePath);
      expect(fetch_.downloads()).toBe(2);
    } finally {
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });

  it('rebuilds a tampered store tree from the verified archive, offline of the network', async () => {
    registerAcme(acmeProvider({ hostFetch: true, executables: EXECUTABLES }));
    const fetch_ = countingFetch(tarRoute);
    const cacheRoot = await mkdtemp(join(tmpdir(), 'opm-cache-'));
    try {
      const first = await fetchTool({ purl: EXACT, cacheRoot });
      const target = join(first.storePath, 'bin', 'demo');
      await writeFile(target, 'tampered');

      const second = await fetchTool({ purl: EXACT, cacheRoot });
      expect(second.cached).toBe(true);
      expect(fetch_.downloads()).toBe(1);
      expect(await readFile(target, 'utf8')).toBe(TOOL_SCRIPT);
    } finally {
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });

  it('falls through to download and verify when the cache entry is corrupt, and self-heals', async () => {
    registerAcme(acmeProvider({ hostFetch: true, executables: EXECUTABLES }));
    const fetch_ = countingFetch(tarRoute);
    const cacheRoot = await mkdtemp(join(tmpdir(), 'opm-cache-'));
    try {
      const first = await fetchTool({ purl: EXACT, cacheRoot });
      // Same length, different bytes: only the digest check can catch it.
      const archive = `${first.storePath}.artifact`;
      await chmod(archive, 0o644);
      await writeFile(
        archive,
        TOOL_TAR.map((byte) => byte ^ 0xff),
      );

      // The corrupt entry must not make a runnable tool fail: the run falls
      // back to the bounded download and verifies as if uncached.
      const second = await fetchTool({ purl: EXACT, cacheRoot });
      expect(second.cached).toBe(false);
      expect(fetch_.downloads()).toBe(2);
      expect(
        await readFile(join(second.storePath, 'bin', 'demo'), 'utf8'),
      ).toBe(TOOL_SCRIPT);

      // Self-healed: the archive now holds the verified bytes again.
      const third = await fetchTool({ purl: EXACT, cacheRoot });
      expect(third.cached).toBe(true);
      expect(fetch_.downloads()).toBe(2);
    } finally {
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });

  it('re-downloads when the archive is gone but the tree survived', async () => {
    registerAcme(acmeProvider({ hostFetch: true, executables: EXECUTABLES }));
    const fetch_ = countingFetch(tarRoute);
    const cacheRoot = await mkdtemp(join(tmpdir(), 'opm-cache-'));
    try {
      const first = await fetchTool({ purl: EXACT, cacheRoot });
      await rm(`${first.storePath}.artifact`, { force: true });

      // The tree alone is not a trusted cache entry — nothing re-verified it
      // against the digest — so the bytes move again.
      const second = await fetchTool({ purl: EXACT, cacheRoot });
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
    vi.stubGlobal('fetch', fetchStub(tarRoute));
    const cacheRoot = await mkdtemp(join(tmpdir(), 'opm-native-run-'));
    try {
      const tool = await fetchTool({ purl: EXACT, cacheRoot });
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
