/**
 * In-process fixture registry for `opm plugin` CLI tests: one plugin, one
 * version, bytes pinned by digest. Mirrors the plugin-store test fixtures;
 * kept tiny and local so the CLI tests read as CLI tests.
 */
import { createHash } from 'node:crypto';
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
