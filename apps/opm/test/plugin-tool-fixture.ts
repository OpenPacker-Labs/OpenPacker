/**
 * Store-resident acme plugin whose package is actually runnable: the inspect
 * answer declares a native executable and the fetch-artifact-record answer
 * carries honest digest/size/locations for a real tar of tool bytes.
 *
 * Mirrors plugin-fixture.ts, which pins the v1 metadata-only shape; layer 04
 * upgrades that fixture's tool bytes and this file folds back into it.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export const ACME_TOOL_ENDPOINT = 'https://acme-tools.fixture.test';

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

export const ACME_TOOL_TAR = tarEntry(
  'bin/acme-tool',
  new TextEncoder().encode('#!/bin/sh\necho acme-tool-ran "$@"\n'),
  0o755,
);
const TOOL_DIGEST = createHash('sha256').update(ACME_TOOL_TAR).digest('hex');

const ACME_DEFINITION = {
  registryDefinitionVersion: '1',
  registryId: 'urn:openpacker:registry:acme-tools-fixture',
  displayName: 'Acme tools fixture registry',
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

/** Honest metadata: the digest and size of the real tool tar. */
const ACME_ARTIFACT_BODY = {
  digest: { algorithm: 'sha256', value: TOOL_DIGEST },
  size: ACME_TOOL_TAR.byteLength,
  mediaType: 'application/x-tar',
  locations: [{ uri: `${ACME_TOOL_ENDPOINT}/artifacts/demo-1.0.0.tar` }],
  registryMetadata: {
    registryId: 'urn:openpacker:registry:acme-tools-fixture',
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

const ACME_METADATA_RECORD = {
  ...ACME_RECORD,
  body: { time: { '1.0.0': '2020-01-01T00:00:00.000Z' } },
};

const ACME_INSPECTION = {
  package: ACME_INSTANCE,
  record: ACME_METADATA_RECORD,
  executables: [
    { name: 'acme-tool', path: 'bin/acme-tool', interpreter: 'native' },
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
 * Write a plugin store entry directly, exactly as `opm plugin add` leaves it:
 * validated manifest, executable, and a pin index whose tree digest covers
 * the materialized entry. No registry or network is involved.
 */
export async function seedRunnablePluginStore(
  storeRoot: string,
): Promise<void> {
  const { stableStoreTreeDigest, writeStableFile } = await import(
    '@openpacker/opm-project'
  );
  const id = 'dev.example.acme-tools-adapter';
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
    .update('runnable-fixture')
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
}
