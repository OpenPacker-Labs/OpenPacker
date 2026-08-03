import { describe, expect, it } from 'vitest';
import { formatDigest } from '@openpacker/canonical';
import type { PackageInstance } from '@openpacker/contracts';
import {
  CatalogSnapshotBuilder,
  InMemoryCatalogStore,
  verifyCatalogSnapshot,
} from './index.js';

const digest = (character: string) => ({
  algorithm: 'sha256' as const,
  value: character.repeat(64),
});
const packageInstance = (name: string, version = '1.0.0'): PackageInstance => ({
  nodeId: `sha256:${(version === '1.0.0' ? '1' : '3').repeat(64)}`,
  identity: {
    canonicalPurl: `pkg:npm/${name}`,
    exactPurl: `pkg:npm/${name}@${version}`,
    purlType: 'npm',
    name,
    version,
    qualifiers: {},
    nativeCoordinates: [],
    aliases: [],
    sourceRefs: [],
    publisherRefs: [],
    externalRefs: [],
  },
  nativeVersion: version,
  normalizedVersion: version,
  versionSortKey: version,
  requirements: [],
  capabilities: [],
  conflicts: [],
  cardinalityConstraints: [],
  artifacts: [],
  lifecycle: { status: 'published', eligible: true, warnings: [] },
  sourceSnapshots: [],
  metadataDigest: digest('2'),
  nativeSemantics: { version: 'npm-v1', data: {} },
  semanticLoss: [],
});

const provenance = {
  providerId: 'fixture',
  endpoint: 'https://fixtures.test',
  retrievedAt: '2026-08-02T00:00:00Z',
  evaluationTime: '2026-08-02T00:00:00Z',
  metadataDigest: digest('2'),
};

describe('catalog snapshots', () => {
  it('sorts records canonically and replays byte-identically offline', async () => {
    const builder = new CatalogSnapshotBuilder(
      'fixture',
      'npm-registry',
      'https://fixtures.test',
      '2026-08-02T00:00:00Z',
      '2026-08-02T00:00:00Z',
      'fixture-r1',
      '"etag"',
    );
    builder.add({
      key: 'pkg:npm/z@1.0.0',
      package: packageInstance('z'),
      rawMetadata: { name: 'z' },
      provenance,
      semanticLoss: [],
    });
    builder.add({
      key: 'pkg:npm/a@1.0.0',
      package: packageInstance('a'),
      rawMetadata: { name: 'a' },
      provenance,
      semanticLoss: [],
    });
    const bundle = await builder.build();
    expect(bundle.records.map((record) => record.key)).toEqual([
      'pkg:npm/a@1.0.0',
      'pkg:npm/z@1.0.0',
    ]);
    await expect(verifyCatalogSnapshot(bundle)).resolves.toBeUndefined();
    const store = new InMemoryCatalogStore();
    await store.put(bundle);
    const bytes = store.export(formatDigest(bundle.snapshot.rootDigest));
    const replay = new InMemoryCatalogStore();
    const imported = await replay.import(bytes);
    expect(imported.bundleDigest).toEqual(bundle.bundleDigest);
    expect(replay.export(formatDigest(bundle.snapshot.rootDigest))).toEqual(
      bytes,
    );
  });

  it('fails closed when record content changes', async () => {
    const builder = new CatalogSnapshotBuilder(
      'fixture',
      'npm-registry',
      'https://fixtures.test',
      '2026-08-02T00:00:00Z',
      '2026-08-02T00:00:00Z',
    );
    builder.add({
      key: 'pkg:npm/a@1.0.0',
      package: packageInstance('a'),
      rawMetadata: { name: 'a' },
      provenance,
      semanticLoss: [],
    });
    const bundle = await builder.build();
    (bundle.records[0]!.rawMetadata as { name: string }).name = 'tampered';
    await expect(verifyCatalogSnapshot(bundle)).rejects.toThrow(
      /Record digest mismatch/,
    );
  });

  it('captures competing exact versions from one provider record history', async () => {
    const builder = new CatalogSnapshotBuilder(
      'fixture',
      'npm-registry',
      'https://fixtures.test',
      '2026-08-02T00:00:00Z',
      '2026-08-02T00:00:00Z',
    );
    for (const version of ['1.0.0', '1.1.0'])
      builder.addProviderRecord({
        record: {
          key: 'pkg:npm/a',
          endpoint: 'https://fixtures.test/a',
          retrievedAt: '2026-08-02T00:00:00Z',
          body: { name: 'a', version },
          rawBody: new TextEncoder().encode(`a@${version}`),
        },
        package: packageInstance('a', version),
        rawMetadata: { name: 'a', version },
        provenance,
      });
    const bundle = await builder.build();
    expect(bundle.records.map(({ key }) => key)).toEqual([
      'pkg:npm/a@1.0.0',
      'pkg:npm/a@1.1.0',
    ]);
    expect(bundle.records[0]?.rawMetadataDigest).not.toEqual(
      bundle.records[1]?.rawMetadataDigest,
    );
  });
});
