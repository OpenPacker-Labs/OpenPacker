import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { FixtureHttpTransport } from '@openpacker/adapter-core';
import {
  CargoCodec,
  CargoSparseProvider,
  parseCargoLock,
  sparseIndexPath,
  type CargoIndexRecord,
} from './index.js';

const indexBytes = await readFile(
  new URL('../../../fixtures/catalogs/cargo/index/demo-zstd', import.meta.url),
);
const records = indexBytes
  .toString()
  .trim()
  .split(/\r?\n/)
  .map((line) => JSON.parse(line) as CargoIndexRecord);
const cargoLockText = await readFile(
  new URL('../../../fixtures/catalogs/cargo/Cargo.lock', import.meta.url),
  'utf8',
);
const archive = await readFile(
  new URL(
    '../../../fixtures/catalogs/cargo/demo-zstd-1.0.0.crate',
    import.meta.url,
  ),
);

describe('Cargo codec', () => {
  const codec = new CargoCodec();
  it('uses Cargo caret defaults and ecosystem ordering', () => {
    expect(codec.satisfies('1.9.0', '1.2.3')).toBe(true);
    expect(codec.satisfies('2.0.0', '1.2.3')).toBe(false);
    expect(codec.satisfies('0.2.9', '0.2.3')).toBe(true);
    expect(codec.satisfies('0.3.0', '0.2.3')).toBe(false);
  });

  it('rejects decoded sparse-index traversal names', () => {
    expect(() =>
      codec.canonicalizePurl('pkg:cargo/%2E%2E%2Fadmin@1.0.0'),
    ).toThrow(/crate name/u);
  });

  it('parses and captures Cargo.lock without invoking Cargo', () => {
    const parsed = parseCargoLock(cargoLockText);
    const capture = codec.translateLockResult(parsed, {
      providerId: 'fixture',
      endpoint: 'https://fixtures.test',
      retrievedAt: '2026-08-02T00:00:00Z',
      evaluationTime: '2026-08-02T00:00:00Z',
      metadataDigest: { algorithm: 'sha256', value: '4'.repeat(64) },
    });
    expect(
      capture.packages.find(
        (entry) => entry.exactPurl === 'pkg:cargo/demo-zstd@1.0.0',
      ),
    ).toMatchObject({
      exactPurl: 'pkg:cargo/demo-zstd@1.0.0',
      artifactDigest:
        'sha256:b78d68511330331a886251deef48b6085bc6f7383d7ed050095bd7928fc4f8ca',
    });
  });
});

it('reads a deterministic sparse-index fixture', async () => {
  expect(sparseIndexPath('demo-zstd')).toBe('de/mo/demo-zstd');
  const body = new TextEncoder().encode(
    records.map((record) => JSON.stringify(record)).join('\n'),
  );
  const provider = new CargoSparseProvider(
    new FixtureHttpTransport(
      new Map([
        [
          'https://fixtures.test/de/mo/demo-zstd',
          [
            { status: 200, headers: { etag: '"cargo-1"' }, body },
            {
              status: 304,
              headers: { etag: '"cargo-1"' },
              body: new Uint8Array(),
            },
          ],
        ],
        [
          'https://fixtures.test/crates/demo-zstd/demo-zstd-1.0.0.crate',
          { status: 200, headers: {}, body: archive },
        ],
      ]),
    ),
    { now: () => '2026-08-02T00:00:00Z' },
    'https://fixtures.test',
    'https://fixtures.test/crates',
  );
  expect(await provider.enumerate('pkg:cargo/demo-zstd')).toEqual([
    'pkg:cargo/demo-zstd@1.0.0-beta.1',
    'pkg:cargo/demo-zstd@1.0.0',
    'pkg:cargo/demo-zstd@1.1.0',
  ]);
  await provider.enumerate('pkg:cargo/demo-zstd');
  const inspection = await provider.inspect('pkg:cargo/demo-zstd@1.0.0');
  expect(inspection.package.requirements[0]?.expression).toMatchObject({
    type: 'conditional',
  });
  expect(inspection.package.nativeSemantics.data).toMatchObject({
    buildAndProcMacroCodeExecuted: false,
  });
  const artifact = await provider.fetchArtifactRecord(
    'pkg:cargo/demo-zstd@1.0.0',
  );
  expect(artifact.rawBody).toEqual(archive);
  expect(artifact.body).toMatchObject({
    digest: {
      value: 'b78d68511330331a886251deef48b6085bc6f7383d7ed050095bd7928fc4f8ca',
    },
    size: 33,
  });
  const snapshot = await provider.snapshot('2026-08-02T00:00:00Z');
  expect(snapshot).toMatchObject({ etag: '"cargo-1"' });
  expect(snapshot.revision).toMatch(/^sha256:/);
});

it('reports corrupt sparse-index JSON with a stable line number', async () => {
  const provider = new CargoSparseProvider(
    new FixtureHttpTransport(
      new Map([
        [
          'https://fixtures.test/de/mo/demo-zstd',
          {
            status: 200,
            headers: {},
            body: new TextEncoder().encode('{broken'),
          },
        ],
      ]),
    ),
    { now: () => '2026-08-02T00:00:00Z' },
    'https://fixtures.test',
  );
  await expect(provider.enumerate('pkg:cargo/demo-zstd')).rejects.toMatchObject(
    {
      code: 'INVALID_PROVIDER_METADATA',
      message: 'Invalid Cargo sparse index JSON at line 1',
    },
  );
});
