/**
 * In-process fixture registry for `opm plugin` CLI tests: one plugin, one
 * version, bytes pinned by digest. Mirrors the plugin-store test fixtures;
 * kept tiny and local so the CLI tests read as CLI tests.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { FixtureHttpTransport } from '@openpacker/adapter-core';
import { canonicalBytes } from '@openpacker/canonical';

const ENDPOINT = 'https://plugins.fixture.test';

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

export function fixturePluginTransport(): FixtureHttpTransport {
  const manifest = canonicalBytes({
    delegatedAdapterVersion: '1',
    id: 'dev.example.acme-adapter',
    purlTypes: ['acme'],
    capabilities: ['registry-definition', 'catalog'],
    executable: 'acme-adapter',
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
  const artifact = tar([
    { name: 'plugin.json', data: manifest, mode: 0o644 },
    {
      name: 'acme-adapter',
      data: new TextEncoder().encode('#!/bin/sh\necho acme\n'),
      mode: 0o755,
    },
  ]);
  const digest = createHash('sha256').update(artifact).digest('hex');
  const json = (value: unknown) => ({
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode(JSON.stringify(value)),
  });
  return new FixtureHttpTransport(
    new Map([
      [
        `${ENDPOINT}/.well-known/prex-registry`,
        json({
          registryDefinitionVersion: '1',
          registryId: ENDPOINT,
          purlTypes: ['opm-plugin'],
          resources: [
            { '@id': '#metadata', '@type': 'prex.registry.package-metadata/1' },
            { '@id': '#manifest', '@type': 'prex.registry.package-manifest/1' },
            {
              '@id': '#enumerate',
              '@type': 'prex.registry.enumerate-versions/1',
            },
            { '@id': '#artifact', '@type': 'prex.registry.artifact/1' },
          ],
        }),
      ],
      [
        `${ENDPOINT}/v1/packages/acme/versions`,
        json({
          name: 'acme',
          versions: [
            {
              version: '1.0.0',
              status: 'active',
              isLatest: true,
              publishedAt: '2020-01-01T00:00:00.000Z',
            },
          ],
        }),
      ],
      [
        `${ENDPOINT}/v1/packages/acme/versions/1.0.0`,
        json({
          manifest: {
            packageManifestVersion: '1',
            name: 'acme',
            version: '1.0.0',
            distributions: [
              {
                purlType: 'opm-plugin',
                identifier: 'acme',
                version: '1.0.0',
                exactPurl: 'pkg:opm-plugin/acme@1.0.0',
                digest: { algorithm: 'sha256', value: digest },
                size: artifact.byteLength,
                mediaType: 'application/x-tar',
                locations: [`${ENDPOINT}/artifacts/acme-1.0.0.tar`],
              },
            ],
          },
          registryMetadata: {
            registryId: ENDPOINT,
            status: 'active',
            publishedAt: '2020-01-01T00:00:00.000Z',
            isLatest: true,
          },
        }),
      ],
      [
        `${ENDPOINT}/artifacts/acme-1.0.0.tar`,
        {
          status: 200,
          headers: { 'content-type': 'application/x-tar' },
          body: artifact,
        },
      ],
    ]),
  );
}

/**
 * A store-resident acme plugin that actually answers the delegated protocol:
 * the same shape `opm plugin add` leaves behind (pin index + tree-digest
 * verified entry), with an executable that speaks the bounded stdio protocol
 * instead of the trivial echo the acquisition fixture ships.
 *
 * Honesty invariant: the plugin is the metadata authority and the stdio
 * protocol stays metadata-only. Its fetch-artifact-record answer carries the
 * true sha256 and size of the real tool tar and a location on the record
 * endpoint's origin; the host downloads the bytes itself (bounded transport,
 * same-origin as the record endpoint, no credentials) and digest-verifies
 * them before anything is materialized or run (ADR 0040).
 */

export const ACME_TOOL_ENDPOINT = 'https://acme.fixture.test';

/** The tool the seeded plugin serves: a standalone POSIX sh executable. */
export const ACME_TOOL_SCRIPT = '#!/bin/sh\necho acme-demo-ran "$@"\n';

export const ACME_TOOL_TAR = tar([
  {
    name: 'bin/acme-demo',
    data: new TextEncoder().encode(ACME_TOOL_SCRIPT),
    mode: 0o755,
  },
]);
const TOOL_DIGEST = createHash('sha256').update(ACME_TOOL_TAR).digest('hex');

const ACME_DEFINITION = {
  registryDefinitionVersion: '1',
  registryId: 'urn:openpacker:registry:acme-fixture',
  displayName: 'Acme fixture registry',
  purlTypes: ['acme'],
  resources: [
    { '@id': '#metadata', '@type': 'prex.registry.package-metadata/1' },
    { '@id': '#enumerate', '@type': 'prex.registry.enumerate-versions/1' },
    { '@id': '#artifact', '@type': 'prex.registry.artifact/1' },
  ],
};

const ACME_IDENTITY = {
  canonicalPurl: 'pkg:acme/demo',
  purlType: 'acme',
  name: 'demo',
  qualifiers: {},
  nativeCoordinates: [],
  aliases: [],
  sourceRefs: [],
  publisherRefs: [],
  externalRefs: [],
};

const ACME_INSTANCE = {
  nodeId: `sha256:${TOOL_DIGEST}`,
  identity: { ...ACME_IDENTITY, exactPurl: 'pkg:acme/demo@1.0.0' },
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
};

/**
 * The artifact record the plugin answers with: honest metadata. The digest
 * and size are those of the real tool tar (ACME_TOOL_TAR), and the location
 * sits on the record endpoint's origin so the host-side fetch is allowed.
 */
const ACME_ARTIFACT_BODY = {
  digest: { algorithm: 'sha256', value: TOOL_DIGEST },
  size: ACME_TOOL_TAR.byteLength,
  mediaType: 'application/x-tar',
  locations: [{ uri: `${ACME_TOOL_ENDPOINT}/artifacts/demo-1.0.0.tar` }],
  registryMetadata: {
    registryId: 'urn:openpacker:registry:acme-fixture',
    status: 'active',
    publishedAt: '2020-01-01T00:00:00.000Z',
    isLatest: true,
  },
};

const ACME_RECORD = {
  key: 'pkg:acme/demo@1.0.0',
  endpoint: ACME_TOOL_ENDPOINT,
  body: ACME_ARTIFACT_BODY,
  retrievedAt: '2020-01-01T00:00:00Z',
};

// inspect carries the metadata document; publishedAt evidence uses the same
// packument shape the npm adapter produces (`time[version]`), which is what
// the supply-chain release-age policy reads.
const ACME_METADATA_RECORD = {
  ...ACME_RECORD,
  body: { time: { '1.0.0': '2020-01-01T00:00:00.000Z' } },
};

// The inspection declares the package's executables (spec §Executables): one
// native bin inside the artifact the record above publishes.
const ACME_INSPECTION = {
  package: ACME_INSTANCE,
  record: ACME_METADATA_RECORD,
  executables: [
    { name: 'acme-demo', path: 'bin/acme-demo', interpreter: 'native' },
  ],
  warnings: [],
};

function okResponse(result: unknown): string {
  return JSON.stringify({
    delegatedAdapterResponseVersion: '1',
    ok: true,
    result,
  });
}

/** Standalone POSIX sh plugin answering each operation from a canned table. */
function answeringScript(): string {
  const answer = (result: unknown) => `'${okResponse(result)}'`;
  return `#!/bin/sh
op="$1"
cat >/dev/null
case "$op" in
  registry-definition) printf '%s' ${answer(ACME_DEFINITION)} ;;
  identify) printf '%s' ${answer([ACME_IDENTITY])} ;;
  enumerate) printf '%s' ${answer(['pkg:acme/demo@1.0.0'])} ;;
  inspect) printf '%s' ${answer(ACME_INSPECTION)} ;;
  fetch-artifact-record) printf '%s' ${answer(ACME_RECORD)} ;;
  *) exit 9 ;;
esac
`;
}

/**
 * A global-fetch stand-in for the fixture transport the host-side artifact
 * download runs through: serves the tool tar from its published location
 * (pass `body` to serve tampered bytes) and 404s everything else.
 */
export function acmeToolFetch(
  body: Uint8Array = ACME_TOOL_TAR,
): (input: URL | Request | string) => Promise<Response> {
  return async (input) => {
    if (String(input) === `${ACME_TOOL_ENDPOINT}/artifacts/demo-1.0.0.tar`)
      return new Response(body, { status: 200 });
    return new Response('missing', { status: 404 });
  };
}

export interface SeededPluginStore {
  storeRoot: string;
  storePath: string;
  /** Manifest id — the key `[plugins.<id>]` bindings use. */
  id: string;
  /** Artifact digest naming the store entry; what a project binding pins. */
  storeDigest: string;
}

/**
 * Write a plugin store entry directly, exactly as `opm plugin add` leaves it:
 * validated manifest, executable, and a pin index whose tree digest covers
 * the materialized entry. No registry or network is involved.
 */
export async function seedPluginStore(
  storeRoot: string,
): Promise<SeededPluginStore> {
  const { stableStoreTreeDigest, writeStableFile } = await import(
    '@openpacker/opm-project'
  );
  const id = 'dev.example.acme-adapter';
  const manifest = {
    delegatedAdapterVersion: '1',
    id,
    purlTypes: ['acme'],
    capabilities: ['registry-definition', 'catalog'],
    executable: 'acme-adapter',
    commands: {
      'registry-definition': { arguments: ['registry-definition'] },
      identify: { arguments: ['identify'] },
      enumerate: { arguments: ['enumerate'] },
      inspect: { arguments: ['inspect'] },
      'fetch-artifact-record': { arguments: ['fetch-artifact-record'] },
    },
    authority: { network: 'never', environment: [] },
  };
  const storeDigest = `sha256:${createHash('sha256')
    .update(id)
    .update('answering-fixture')
    .digest('hex')}`;
  const storePath = join(storeRoot, `sha256-${storeDigest.slice(7)}`);
  await writeStableFile(
    join(storePath, 'plugin.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  await writeStableFile(
    join(storePath, 'acme-adapter'),
    answeringScript(),
    0o755,
  );
  const treeDigest = await stableStoreTreeDigest(storePath);
  await writeStableFile(
    join(storeRoot, 'plugins.json'),
    `${JSON.stringify(
      {
        pluginStoreVersion: 1,
        plugins: {
          acme: {
            id,
            name: 'acme',
            exactPurl: 'pkg:opm-plugin/acme@1.0.0',
            storeDigest,
            treeDigest,
            manifestPath: 'plugin.json',
            installedAt: '2026-08-20T00:00:00.000Z',
            format: 'tar',
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  return { storeRoot, storePath, id, storeDigest };
}
