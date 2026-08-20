import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FixtureHttpTransport } from '@openpacker/adapter-core';
import { canonicalBytes } from '@openpacker/canonical';
import { configureAdapters } from '@openpacker/opm-project';
import {
  addPlugin,
  listPlugins,
  parsePluginSpec,
  pluginRegistryModule,
  pluginStoreRoot,
  removePlugin,
  PLUGIN_INDEX_NAME,
  PLUGIN_MANIFEST_NAME,
  PLUGIN_PURL_TYPE,
} from '../src/index.js';

/**
 * Plugin store behaviour against a fixture PREX registry.
 *
 * Nothing here touches a real registry: the transport is a URL→response map.
 * The registry fixtures are shaped exactly like apps/openpacker-registry
 * serves them — a definition, a version list, and entries whose distributions
 * carry digest + location — because that is the shape a production plugin
 * registry speaks.
 */

const ENDPOINT = 'https://plugins.fixture.test';
const NOW = '2026-08-20T00:00:00.000Z';

const temps: string[] = [];

beforeEach(() => {
  // Every test starts with a registry that knows no purl types; addPlugin
  // registers the opm-plugin module lazily with the endpoint it is given.
  configureAdapters([]);
});

afterEach(async () => {
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function storeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'opm-plugin-store-'));
  temps.push(root);
  return join(root, 'plugins');
}

// --- ustar fixture builder (regular files only, root level) ---------------

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
  text(265, 'user\0');
  text(297, 'group\0');
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

function tar(
  entries: readonly { name: string; data: Uint8Array; mode: number }[],
): Uint8Array {
  const blocks = entries.map((entry) =>
    tarEntry(entry.name, entry.data, entry.mode),
  );
  const total = blocks.reduce((sum, block) => sum + block.byteLength, 0) + 1024;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const block of blocks) {
    out.set(block, offset);
    offset += block.byteLength;
  }
  return out;
}

// --- registry fixtures -----------------------------------------------------

function pluginManifest(id: string, executable: string): Uint8Array {
  return canonicalBytes({
    delegatedAdapterVersion: '1',
    id,
    purlTypes: ['acme'],
    capabilities: ['registry-definition', 'catalog'],
    executable,
    commands: {
      'registry-definition': { arguments: ['registry-definition'] },
      identify: { arguments: ['catalog', 'identify'] },
      enumerate: { arguments: ['catalog', 'enumerate'] },
      inspect: { arguments: ['catalog', 'inspect'] },
      'fetch-artifact-record': {
        arguments: ['catalog', 'fetch-artifact-record'],
      },
    },
    authority: { network: 'never', environment: [] },
  } as never);
}

const EXECUTABLE = new TextEncoder().encode('#!/bin/sh\necho acme\n');

interface FixtureVersion {
  version: string;
  /** Bytes the registry metadata describes (digest and size are over these). */
  artifact: Uint8Array;
  /** Bytes actually served at the location; defaults to `artifact`. */
  servedBytes?: Uint8Array;
  status?: 'active' | 'deprecated' | 'deleted';
  publishedAt?: string;
}

function pluginArtifact(manifest: Uint8Array, executable = 'acme-adapter') {
  return tar([
    { name: 'plugin.json', data: manifest, mode: 0o644 },
    { name: executable, data: EXECUTABLE, mode: 0o755 },
  ]);
}

function registryFixture(
  plugins: Readonly<Record<string, readonly FixtureVersion[]>>,
): FixtureHttpTransport {
  const fixtures = new Map<
    string,
    { status: number; headers: Record<string, string>; body: Uint8Array }
  >();
  const json = (value: unknown) => ({
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode(JSON.stringify(value)),
  });
  fixtures.set(
    `${ENDPOINT}/.well-known/prex-registry`,
    json({
      registryDefinitionVersion: '1',
      registryId: ENDPOINT,
      displayName: 'Fixture plugin registry',
      purlTypes: [PLUGIN_PURL_TYPE],
      resources: [
        { '@id': '#metadata', '@type': 'prex.registry.package-metadata/1' },
        { '@id': '#manifest', '@type': 'prex.registry.package-manifest/1' },
        { '@id': '#enumerate', '@type': 'prex.registry.enumerate-versions/1' },
        { '@id': '#artifact', '@type': 'prex.registry.artifact/1' },
      ],
    }),
  );
  for (const [name, versions] of Object.entries(plugins)) {
    fixtures.set(
      `${ENDPOINT}/v1/packages/${name}/versions`,
      json({
        name,
        versions: versions.map((entry, index) => ({
          version: entry.version,
          status: entry.status ?? 'active',
          isLatest: index === versions.length - 1,
          publishedAt: entry.publishedAt ?? '2020-01-01T00:00:00.000Z',
        })),
      }),
    );
    for (const entry of versions) {
      const digest = createHash('sha256').update(entry.artifact).digest('hex');
      const location = `${ENDPOINT}/artifacts/${name}-${entry.version}.tar`;
      fixtures.set(location, {
        status: 200,
        headers: { 'content-type': 'application/x-tar' },
        body: entry.servedBytes ?? entry.artifact,
      });
      fixtures.set(
        `${ENDPOINT}/v1/packages/${name}/versions/${entry.version}`,
        json({
          manifest: {
            packageManifestVersion: '1',
            name,
            version: entry.version,
            distributions: [
              {
                purlType: PLUGIN_PURL_TYPE,
                identifier: name,
                version: entry.version,
                exactPurl: `pkg:${PLUGIN_PURL_TYPE}/${name}@${entry.version}`,
                digest: { algorithm: 'sha256', value: digest },
                size: entry.artifact.byteLength,
                mediaType: 'application/x-tar',
                locations: [location],
              },
            ],
          },
          registryMetadata: {
            registryId: ENDPOINT,
            status: entry.status ?? 'active',
            publishedAt: entry.publishedAt ?? '2020-01-01T00:00:00.000Z',
            isLatest: true,
          },
        }),
      );
    }
  }
  return new FixtureHttpTransport(fixtures);
}

function acmeFixture(): {
  transport: FixtureHttpTransport;
  artifact: Uint8Array;
  digest: string;
} {
  const artifact = pluginArtifact(
    pluginManifest('dev.example.acme-adapter', 'acme-adapter'),
  );
  return {
    transport: registryFixture({ acme: [{ version: '1.0.0', artifact }] }),
    artifact,
    digest: `sha256:${createHash('sha256').update(artifact).digest('hex')}`,
  };
}

const now = () => NOW;

// --- pluginStoreRoot --------------------------------------------------------

describe('pluginStoreRoot', () => {
  it('honours an absolute OPM_PLUGIN_HOME', () => {
    expect(pluginStoreRoot({ OPM_PLUGIN_HOME: '/data/plugins' })).toBe(
      '/data/plugins',
    );
  });

  it('refuses a relative OPM_PLUGIN_HOME', () => {
    expect(() =>
      pluginStoreRoot({ OPM_PLUGIN_HOME: 'relative/plugins' }),
    ).toThrow(/absolute path/u);
  });

  it('falls back to XDG_DATA_HOME, then the home directory', () => {
    expect(pluginStoreRoot({ XDG_DATA_HOME: '/xdg' })).toBe(
      '/xdg/openpacker/plugins',
    );
    const fallback = pluginStoreRoot({});
    expect(fallback).toMatch(/\.local\/share\/openpacker\/plugins$/u);
  });
});

// --- add / list / remove ----------------------------------------------------

describe('plugin add', () => {
  it('installs a plugin: verified bytes, validated manifest, recorded pin', async () => {
    const fixture = acmeFixture();
    const root = await storeRoot();
    const installed = await addPlugin({
      name: 'acme',
      endpoint: ENDPOINT,
      transport: fixture.transport,
      storeRoot: root,
      now,
    });
    expect(installed.exactPurl).toBe('pkg:opm-plugin/acme@1.0.0');
    expect(installed.id).toBe('dev.example.acme-adapter');
    expect(installed.storeDigest).toBe(fixture.digest);
    expect(installed.installedAt).toBe(NOW);
    expect(installed.alreadyInstalled).toBe(false);
    // Fresh acquire: bytes came from the registry, not the cache.
    expect(installed.cached).toBe(false);
    expect(installed.storePath).toBe(
      join(root, `sha256-${fixture.digest.slice('sha256:'.length)}`),
    );
    // The store entry holds exactly the manifest and the executable.
    const manifest = JSON.parse(
      await readFile(join(installed.storePath, PLUGIN_MANIFEST_NAME), 'utf8'),
    ) as { id: string };
    expect(manifest.id).toBe('dev.example.acme-adapter');
    const executable = await stat(join(installed.storePath, 'acme-adapter'));
    expect((executable.mode & 0o111) !== 0).toBe(true);
    // The verified artifact bytes are cached for offline repair, read-only.
    const cached = await readFile(`${installed.storePath}.artifact`);
    expect(new Uint8Array(cached)).toEqual(fixture.artifact);
    expect(
      ((await stat(`${installed.storePath}.artifact`)).mode & 0o222) === 0,
    ).toBe(true);
    // The pin index records exactly what the spec names.
    const index = JSON.parse(
      await readFile(join(root, PLUGIN_INDEX_NAME), 'utf8'),
    ) as { plugins: Record<string, Record<string, string>> };
    expect(index.plugins['acme']).toMatchObject({
      id: 'dev.example.acme-adapter',
      exactPurl: 'pkg:opm-plugin/acme@1.0.0',
      storeDigest: fixture.digest,
      manifestPath: PLUGIN_MANIFEST_NAME,
      installedAt: NOW,
    });
    expect(index.plugins['acme']!.treeDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it('picks the newest published version when none is given', async () => {
    const v1 = pluginArtifact(
      pluginManifest('dev.example.acme-adapter', 'acme-adapter'),
    );
    const v2 = pluginArtifact(
      pluginManifest('dev.example.acme-adapter', 'acme-adapter'),
    );
    const transport = registryFixture({
      acme: [
        { version: '1.0.0', artifact: v1 },
        { version: '1.1.0', artifact: v2 },
      ],
    });
    const installed = await addPlugin({
      name: 'acme',
      endpoint: ENDPOINT,
      transport,
      storeRoot: await storeRoot(),
      now,
    });
    expect(installed.exactPurl).toBe('pkg:opm-plugin/acme@1.1.0');
  });

  it('trusts the registry isLatest flag, not lexical order (1.10.0 > 1.9.0)', async () => {
    // Regression: a lexicographic sort of purl strings ranks "...@1.9.0"
    // after "...@1.10.0", so the wrong version was picked as newest.
    const v9 = pluginArtifact(
      pluginManifest('dev.example.acme-adapter', 'acme-adapter'),
    );
    const v10 = pluginArtifact(
      pluginManifest('dev.example.acme-adapter', 'acme-adapter'),
    );
    const transport = registryFixture({
      acme: [
        { version: '1.9.0', artifact: v9 },
        { version: '1.10.0', artifact: v10 },
      ],
    });
    const installed = await addPlugin({
      name: 'acme',
      endpoint: ENDPOINT,
      transport,
      storeRoot: await storeRoot(),
      now,
    });
    expect(installed.exactPurl).toBe('pkg:opm-plugin/acme@1.10.0');
  });

  it('installs an exact version when asked', async () => {
    const artifact = pluginArtifact(
      pluginManifest('dev.example.acme-adapter', 'acme-adapter'),
    );
    const transport = registryFixture({
      acme: [
        { version: '1.0.0', artifact },
        { version: '1.1.0', artifact },
      ],
    });
    const installed = await addPlugin({
      name: 'acme',
      version: '1.0.0',
      endpoint: ENDPOINT,
      transport,
      storeRoot: await storeRoot(),
      now,
    });
    expect(installed.exactPurl).toBe('pkg:opm-plugin/acme@1.0.0');
  });

  it('is idempotent: a second add of the same pin verifies and reuses', async () => {
    const fixture = acmeFixture();
    const root = await storeRoot();
    await addPlugin({
      name: 'acme',
      endpoint: ENDPOINT,
      transport: fixture.transport,
      storeRoot: root,
      now,
    });
    const requests = fixture.transport.requests.length;
    const again = await addPlugin({
      name: 'acme',
      storeRoot: root,
      now,
    });
    expect(again.alreadyInstalled).toBe(true);
    // The intact pin answered; nothing was read from the `.artifact` cache.
    expect(again.cached).toBe(false);
    // The pin was intact, so nothing was fetched at all.
    expect(fixture.transport.requests.length).toBe(requests);
  });

  it('honestly refuses a second version instead of silently replacing', async () => {
    const artifact = pluginArtifact(
      pluginManifest('dev.example.acme-adapter', 'acme-adapter'),
    );
    const transport = registryFixture({
      acme: [
        { version: '1.0.0', artifact },
        { version: '1.1.0', artifact },
      ],
    });
    const root = await storeRoot();
    await addPlugin({
      name: 'acme',
      version: '1.0.0',
      endpoint: ENDPOINT,
      transport,
      storeRoot: root,
      now,
    });
    await expect(
      addPlugin({ name: 'acme', version: '1.1.0', storeRoot: root, now }),
    ).rejects.toMatchObject({
      code: 'PLUGIN_ALREADY_INSTALLED',
    });
  });

  it('refuses a second plugin declaring an already-installed manifest id', async () => {
    // Manifest ids name project bindings (`[plugins.<id>]`), so one id must
    // not be provided by two install names.
    const sharedId = 'dev.example.shared-adapter';
    const transport = registryFixture({
      acme: [
        {
          version: '1.0.0',
          artifact: pluginArtifact(pluginManifest(sharedId, 'acme-adapter')),
        },
      ],
      acme2: [
        {
          version: '1.0.0',
          artifact: pluginArtifact(pluginManifest(sharedId, 'acme-adapter')),
        },
      ],
    });
    const root = await storeRoot();
    await addPlugin({
      name: 'acme',
      endpoint: ENDPOINT,
      transport,
      storeRoot: root,
      now,
    });
    await expect(
      addPlugin({
        name: 'acme2',
        endpoint: ENDPOINT,
        transport,
        storeRoot: root,
        now,
      }),
    ).rejects.toMatchObject({ code: 'PLUGIN_ID_CONFLICT' });
    // The conflicting plugin was refused before anything was pinned.
    const listed = await listPlugins({ storeRoot: root });
    expect(listed.map((plugin) => plugin.name)).toEqual(['acme']);
  });

  it('rejects bytes that do not match the digest the registry published', async () => {
    // The supply-chain case: the metadata states one digest, the location
    // serves other bytes. Verification must fail before anything is stored.
    const artifact = pluginArtifact(
      pluginManifest('dev.example.acme-adapter', 'acme-adapter'),
    );
    const tampered = new Uint8Array(artifact.byteLength);
    tampered.set(artifact);
    tampered[tampered.byteLength - 10]! ^= 0xff;
    const transport = registryFixture({
      acme: [{ version: '1.0.0', artifact, servedBytes: tampered }],
    });
    const root = await storeRoot();
    await expect(
      addPlugin({
        name: 'acme',
        endpoint: ENDPOINT,
        transport,
        storeRoot: root,
        now,
      }),
    ).rejects.toMatchObject({ code: 'DIGEST_MISMATCH' });
    expect(await listPlugins({ storeRoot: root })).toEqual([]);
  });

  it('refuses a malformed manifest at add time', async () => {
    const broken = canonicalBytes({
      delegatedAdapterVersion: '1',
      id: 'dev.example.broken',
      // purlTypes, capabilities, executable, commands, authority missing
    } as never);
    const artifact = tar([
      { name: 'plugin.json', data: broken, mode: 0o644 },
      { name: 'broken-adapter', data: EXECUTABLE, mode: 0o755 },
    ]);
    const transport = registryFixture({
      broken: [{ version: '1.0.0', artifact }],
    });
    const root = await storeRoot();
    await expect(
      addPlugin({
        name: 'broken',
        endpoint: ENDPOINT,
        transport,
        storeRoot: root,
        now,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PLUGIN_MANIFEST' });
    // Nothing reached the store: no pin, no entry.
    expect(await listPlugins({ storeRoot: root })).toEqual([]);
  });

  it('refuses artifacts with extra files or directories', async () => {
    const artifact = tar([
      {
        name: 'plugin.json',
        data: pluginManifest('dev.example.acme-adapter', 'acme-adapter'),
        mode: 0o644,
      },
      { name: 'acme-adapter', data: EXECUTABLE, mode: 0o755 },
      {
        name: 'README.md',
        data: new TextEncoder().encode('surprise'),
        mode: 0o644,
      },
    ]);
    const transport = registryFixture({
      acme: [{ version: '1.0.0', artifact }],
    });
    await expect(
      addPlugin({
        name: 'acme',
        endpoint: ENDPOINT,
        transport,
        storeRoot: await storeRoot(),
        now,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PLUGIN_ARTIFACT' });
  });

  it('refuses an executable entry without the executable bit', async () => {
    const artifact = tar([
      {
        name: 'plugin.json',
        data: pluginManifest('dev.example.acme-adapter', 'acme-adapter'),
        mode: 0o644,
      },
      { name: 'acme-adapter', data: EXECUTABLE, mode: 0o644 },
    ]);
    const transport = registryFixture({
      acme: [{ version: '1.0.0', artifact }],
    });
    await expect(
      addPlugin({
        name: 'acme',
        endpoint: ENDPOINT,
        transport,
        storeRoot: await storeRoot(),
        now,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PLUGIN_ARTIFACT' });
  });

  it('refuses path traversal in artifact entries', async () => {
    const artifact = tar([
      {
        name: 'plugin.json',
        data: pluginManifest('dev.example.acme-adapter', 'acme-adapter'),
        mode: 0o644,
      },
      { name: '../acme-adapter', data: EXECUTABLE, mode: 0o755 },
    ]);
    const transport = registryFixture({
      acme: [{ version: '1.0.0', artifact }],
    });
    await expect(
      addPlugin({
        name: 'acme',
        endpoint: ENDPOINT,
        transport,
        storeRoot: await storeRoot(),
        now,
      }),
    ).rejects.toThrow(/PATH_TRAVERSAL/u);
  });

  it('reports an unknown plugin name honestly', async () => {
    const transport = registryFixture({});
    await expect(
      addPlugin({
        name: 'ghost',
        endpoint: ENDPOINT,
        transport,
        storeRoot: await storeRoot(),
        now,
      }),
    ).rejects.toMatchObject({ code: 'PACKAGE_NOT_FOUND' });
  });

  it('fails closed when no plugin registry is configured', async () => {
    const previous = process.env.OPM_REGISTRY_OPM_PLUGIN;
    delete process.env.OPM_REGISTRY_OPM_PLUGIN;
    try {
      await expect(
        addPlugin({ name: 'acme', storeRoot: await storeRoot(), now }),
      ).rejects.toMatchObject({ code: 'PLUGIN_REGISTRY_UNCONFIGURED' });
    } finally {
      if (previous !== undefined)
        process.env.OPM_REGISTRY_OPM_PLUGIN = previous;
    }
  });

  it('is policy-gated: a deprecated release is refused', async () => {
    const artifact = pluginArtifact(
      pluginManifest('dev.example.acme-adapter', 'acme-adapter'),
    );
    const transport = registryFixture({
      acme: [{ version: '1.0.0', artifact, status: 'deprecated' }],
    });
    await expect(
      addPlugin({
        name: 'acme',
        endpoint: ENDPOINT,
        transport,
        storeRoot: await storeRoot(),
        now,
      }),
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  });
});

describe('offline behaviour', () => {
  it('refuses a fresh install while offline', async () => {
    await expect(
      addPlugin({
        name: 'acme',
        offline: true,
        storeRoot: await storeRoot(),
        now,
      }),
    ).rejects.toMatchObject({ code: 'OFFLINE' });
  });

  it('answers from the intact pin while offline, without any fetch', async () => {
    const fixture = acmeFixture();
    const root = await storeRoot();
    await addPlugin({
      name: 'acme',
      endpoint: ENDPOINT,
      transport: fixture.transport,
      storeRoot: root,
      now,
    });
    const requests = fixture.transport.requests.length;
    const installed = await addPlugin({
      name: 'acme',
      offline: true,
      storeRoot: root,
      now,
    });
    expect(installed.alreadyInstalled).toBe(true);
    expect(installed.cached).toBe(false);
    expect(fixture.transport.requests.length).toBe(requests);
  });

  it('repairs a missing entry from the digest-verified cache while offline', async () => {
    const fixture = acmeFixture();
    const root = await storeRoot();
    const installed = await addPlugin({
      name: 'acme',
      endpoint: ENDPOINT,
      transport: fixture.transport,
      storeRoot: root,
      now,
    });
    await rm(installed.storePath, { recursive: true });
    const requests = fixture.transport.requests.length;
    const repaired = await addPlugin({
      name: 'acme',
      offline: true,
      storeRoot: root,
      now,
    });
    expect(repaired.cached).toBe(true);
    expect(repaired.alreadyInstalled).toBe(false);
    expect(fixture.transport.requests.length).toBe(requests);
    const manifest = JSON.parse(
      await readFile(join(repaired.storePath, PLUGIN_MANIFEST_NAME), 'utf8'),
    ) as { id: string };
    expect(manifest.id).toBe('dev.example.acme-adapter');
  });

  it('refuses offline repair when neither entry nor cache is present', async () => {
    const fixture = acmeFixture();
    const root = await storeRoot();
    const installed = await addPlugin({
      name: 'acme',
      endpoint: ENDPOINT,
      transport: fixture.transport,
      storeRoot: root,
      now,
    });
    await rm(installed.storePath, { recursive: true });
    await rm(`${installed.storePath}.artifact`);
    await expect(
      addPlugin({ name: 'acme', offline: true, storeRoot: root, now }),
    ).rejects.toMatchObject({ code: 'OFFLINE' });
  });
});

describe('plugin list / remove', () => {
  it('lists installed plugins and removes them', async () => {
    const fixture = acmeFixture();
    const root = await storeRoot();
    expect(await listPlugins({ storeRoot: root })).toEqual([]);
    const installed = await addPlugin({
      name: 'acme',
      endpoint: ENDPOINT,
      transport: fixture.transport,
      storeRoot: root,
      now,
    });
    const listed = await listPlugins({ storeRoot: root });
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      name: 'acme',
      id: 'dev.example.acme-adapter',
      exactPurl: 'pkg:opm-plugin/acme@1.0.0',
      present: true,
    });
    const removed = await removePlugin('acme', { storeRoot: root });
    expect(removed.exactPurl).toBe('pkg:opm-plugin/acme@1.0.0');
    expect(await listPlugins({ storeRoot: root })).toEqual([]);
    await expect(stat(installed.storePath)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('names the plugins it knows when removing one that is not installed', async () => {
    const fixture = acmeFixture();
    const root = await storeRoot();
    await addPlugin({
      name: 'acme',
      endpoint: ENDPOINT,
      transport: fixture.transport,
      storeRoot: root,
      now,
    });
    await expect(
      removePlugin('ghost', { storeRoot: root }),
    ).rejects.toMatchObject({ code: 'PLUGIN_NOT_INSTALLED' });
  });

  it('reports a pinned plugin whose store entry vanished as not present', async () => {
    const fixture = acmeFixture();
    const root = await storeRoot();
    const installed = await addPlugin({
      name: 'acme',
      endpoint: ENDPOINT,
      transport: fixture.transport,
      storeRoot: root,
      now,
    });
    await rm(installed.storePath, { recursive: true });
    const listed = await listPlugins({ storeRoot: root });
    expect(listed[0]?.present).toBe(false);
  });
});

describe('plugin specs', () => {
  it('parses bare, versioned, and full-purl specs', () => {
    expect(parsePluginSpec('acme')).toEqual({ name: 'acme' });
    expect(parsePluginSpec('acme@1.2.3')).toEqual({
      name: 'acme',
      version: '1.2.3',
    });
    expect(parsePluginSpec('pkg:opm-plugin/acme@1.2.3')).toEqual({
      name: 'acme',
      version: '1.2.3',
    });
  });

  it('refuses unsafe names and non-plugin purls', () => {
    expect(() => parsePluginSpec('../acme')).toThrow(/Invalid plugin name/u);
    expect(() => parsePluginSpec('ACME')).toThrow(/Invalid plugin name/u);
    expect(() => parsePluginSpec('pkg:npm/acme')).toThrow(/Not a plugin purl/u);
  });
});

describe('adapter module', () => {
  it('is registerable directly and advertises the opm-plugin purl type', () => {
    const module = pluginRegistryModule({ endpoint: ENDPOINT });
    expect(module.purlTypes).toEqual([PLUGIN_PURL_TYPE]);
  });
});
