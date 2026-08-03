import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { FixtureHttpTransport } from '@openpacker/adapter-core';
import { NpmCodec, NpmRegistryProvider, type NpmPackument } from './index.js';

const encoder = new TextEncoder();
const packumentBytes = await readFile(
  new URL('../../../fixtures/catalogs/npm/packument.json', import.meta.url),
);
const packument = JSON.parse(packumentBytes.toString()) as NpmPackument;
const archive = await readFile(
  new URL(
    '../../../fixtures/catalogs/npm/demo-tool-1.1.0.tgz',
    import.meta.url,
  ),
);
const sha256Integrity = packument.versions['1.1.0']!.dist!.integrity!;

describe('npm codec', () => {
  const codec = new NpmCodec();

  it('normalizes scoped coordinates and implements npm ranges', () => {
    expect(
      codec.canonicalizePurl('pkg:NPM/%40OpenPacker/Demo-Tool@v1.0.0'),
    ).toBe('pkg:npm/%40openpacker/demo-tool@1.0.0');
    expect(codec.satisfies('1.9.9', '^1.2.3')).toBe(true);
    expect(codec.satisfies('2.0.0', '^1.2.3')).toBe(false);
    expect(codec.satisfies('1.3.0', '1.2.x || >=1.3.0 <2')).toBe(true);
  });

  it('captures package-lock v3 without executing lifecycle scripts', () => {
    const capture = codec.translateLockResult(
      {
        lockfileVersion: 3,
        packages: {
          'node_modules/@openpacker/demo-tool': {
            name: '@openpacker/demo-tool',
            version: '1.1.0',
            integrity: sha256Integrity,
            dependencies: { alpha: '^1' },
          },
        },
      },
      {
        providerId: 'fixture',
        endpoint: 'https://fixtures.test',
        retrievedAt: '2026-08-02T00:00:00Z',
        evaluationTime: '2026-08-02T00:00:00Z',
        metadataDigest: { algorithm: 'sha256', value: '1'.repeat(64) },
      },
    );
    expect(capture.packages[0]?.exactPurl).toBe(
      'pkg:npm/%40openpacker/demo-tool@1.1.0',
    );
    expect(capture.packages[0]?.native).toMatchObject({
      path: 'node_modules/@openpacker/demo-tool',
    });
  });
});

it('enumerates deterministic fixture metadata and keeps dist-tags mutable', async () => {
  const body = encoder.encode(JSON.stringify(packument));
  const transport = new FixtureHttpTransport(
    new Map([
      [
        'https://fixtures.test/%40openpacker%2Fdemo-tool',
        [
          { status: 200, headers: { etag: '"fixture-1"' }, body },
          {
            status: 304,
            headers: { etag: '"fixture-1"' },
            body: new Uint8Array(),
          },
        ],
      ],
      [
        'https://fixtures.openpacker.invalid/npm/demo-tool-1.1.0.tgz',
        { status: 200, headers: {}, body: archive },
      ],
    ]),
  );
  const provider = new NpmRegistryProvider(
    transport,
    { now: () => '2026-08-02T00:00:00Z' },
    'https://fixtures.test',
  );
  expect(await provider.enumerate('pkg:npm/%40openpacker/demo-tool')).toEqual([
    'pkg:npm/%40openpacker/demo-tool@1.0.0-beta.1',
    'pkg:npm/%40openpacker/demo-tool@1.0.0',
    'pkg:npm/%40openpacker/demo-tool@1.1.0',
  ]);
  await provider.enumerate('pkg:npm/%40openpacker/demo-tool');
  expect(transport.requests[1]?.headers?.['if-none-match']).toBe('"fixture-1"');
  const inspected = await provider.inspect(
    'pkg:npm/%40openpacker/demo-tool@1.0.0',
  );
  expect(inspected.package.semanticLoss.map((loss) => loss.code)).toContain(
    'NPM_LIFECYCLE_SCRIPTS_NOT_EXECUTED',
  );
  expect((inspected.record.body as NpmPackument)['dist-tags']).toEqual({
    latest: '1.1.0',
  });
  const snapshot = await provider.snapshot('2026-08-02T00:00:00Z');
  expect(snapshot.etag).toBe('"fixture-1"');
  expect(snapshot.revision).toMatch(/^sha256:/);
  const artifact = await provider.fetchArtifactRecord(
    'pkg:npm/%40openpacker/demo-tool@1.1.0',
  );
  expect(artifact.rawBody).toEqual(archive);
  expect(artifact.body).toMatchObject({
    digest: {
      algorithm: 'sha256',
      value: 'e0f40f3850655f389d0492397db462d8709417351ff863f38ef0a1fd73e7ba2a',
    },
    size: 31,
    mediaType: 'application/gzip',
  });
  provider.invalidate('pkg:npm/%40openpacker/demo-tool');
});

it('rejects corrupt npm tarball bytes', async () => {
  const corruptArchive = Uint8Array.from(archive);
  corruptArchive[0] = corruptArchive[0]! ^ 1;
  const provider = new NpmRegistryProvider(
    new FixtureHttpTransport(
      new Map([
        [
          'https://fixtures.test/%40openpacker%2Fdemo-tool',
          { status: 200, headers: {}, body: packumentBytes },
        ],
        [
          'https://fixtures.openpacker.invalid/npm/demo-tool-1.1.0.tgz',
          {
            status: 200,
            headers: {},
            body: corruptArchive,
          },
        ],
      ]),
    ),
    { now: () => '2026-08-02T00:00:00Z' },
    'https://fixtures.test',
  );
  await expect(
    provider.fetchArtifactRecord('pkg:npm/%40openpacker/demo-tool@1.1.0'),
  ).rejects.toMatchObject({ code: 'DIGEST_MISMATCH' });
});

it('revalidates ETags and explicit invalidation forces a full fetch', async () => {
  const transport = new FixtureHttpTransport(
    new Map([
      [
        'https://fixtures.test/%40openpacker%2Fdemo-tool',
        [
          {
            status: 200,
            headers: { etag: '"fixture-1"' },
            body: packumentBytes,
          },
          {
            status: 304,
            headers: { etag: '"fixture-1"' },
            body: new Uint8Array(),
          },
          {
            status: 200,
            headers: { etag: '"fixture-2"' },
            body: packumentBytes,
          },
        ],
      ],
    ]),
  );
  const provider = new NpmRegistryProvider(
    transport,
    { now: () => '2026-08-02T00:00:00Z' },
    'https://fixtures.test',
  );
  await provider.enumerate('pkg:npm/%40openpacker/demo-tool');
  await provider.enumerate('pkg:npm/%40openpacker/demo-tool');
  provider.invalidate('pkg:npm/%40openpacker/demo-tool');
  await provider.enumerate('pkg:npm/%40openpacker/demo-tool');
  expect(transport.requests[1]?.headers?.['if-none-match']).toBe('"fixture-1"');
  expect(transport.requests[2]?.headers?.['if-none-match']).toBeUndefined();
  expect((await provider.snapshot('2026-08-02T00:00:00Z')).etag).toBe(
    '"fixture-2"',
  );
});
