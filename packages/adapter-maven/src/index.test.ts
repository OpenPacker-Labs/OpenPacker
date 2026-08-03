import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { FixtureHttpTransport } from '@openpacker/adapter-core';
import {
  MavenCodec,
  MavenRepositoryProvider,
  parseGradleLockfile,
  parseMavenMetadataXml,
  type MavenCatalogEntry,
} from './index.js';

const metadataBytes = await readFile(
  new URL(
    '../../../fixtures/catalogs/maven/maven-metadata-org.example-demo-tool.xml',
    import.meta.url,
  ),
);
const catalogBytes = await readFile(
  new URL(
    '../../../fixtures/catalogs/maven/catalog-org.example-demo-tool-1.0.0.json',
    import.meta.url,
  ),
);
const catalogBetaBytes = await readFile(
  new URL(
    '../../../fixtures/catalogs/maven/catalog-org.example-demo-tool-1.0.0-beta.1.json',
    import.meta.url,
  ),
);
const archive = await readFile(
  new URL(
    '../../../fixtures/catalogs/maven/demo-tool-1.0.0.jar',
    import.meta.url,
  ),
);
const gradleLockText = await readFile(
  new URL('../../../fixtures/catalogs/maven/gradle.lockfile', import.meta.url),
  'utf8',
);

describe('Maven codec', () => {
  const codec = new MavenCodec();

  it('canonicalizes groupId/artifactId PURLs and preserves classifier/type', () => {
    expect(
      codec.canonicalizePurl('pkg:maven/org.example/demo-tool@1.0.0'),
    ).toBe('pkg:maven/org.example/demo-tool@1.0.0');
    expect(
      codec.canonicalizePurl(
        'pkg:maven/org.example/demo-tool@1.0.0?classifier=sources&type=jar',
      ),
    ).toBe('pkg:maven/org.example/demo-tool@1.0.0?classifier=sources');
    expect(
      codec.canonicalizePurl('pkg:maven/org.example/demo-tool@1.0.0?type=war'),
    ).toBe('pkg:maven/org.example/demo-tool@1.0.0?type=war');
  });

  it('parses native coordinates as groupId:artifactId', () => {
    expect(codec.parseNativeCoordinate('org.example:demo-tool:1.0.0')).toEqual({
      ecosystem: 'maven',
      namespace: 'org.example',
      name: 'demo-tool',
      version: '1.0.0',
      original: 'org.example:demo-tool:1.0.0',
    });
    expect(codec.parseGav('org.example:demo-tool:jar:sources:1.0.0')).toEqual({
      groupId: 'org.example',
      artifactId: 'demo-tool',
      packaging: 'jar',
      classifier: 'sources',
      version: '1.0.0',
    });
  });

  it('compares Maven versions with qualifier ordering', () => {
    expect(codec.compareNativeVersions('1.0', '1.0.0')).toBe(0);
    expect(codec.compareNativeVersions('1.0-alpha', '1.0-beta')).toBeLessThan(
      0,
    );
    expect(codec.compareNativeVersions('1.0-beta', '1.0-rc1')).toBeLessThan(0);
    expect(codec.compareNativeVersions('1.0-rc1', '1.0')).toBeLessThan(0);
    expect(codec.compareNativeVersions('1.0', '1.0-sp1')).toBeLessThan(0);
  });

  it('maps hard intervals to VERS and soft bare versions with loss', () => {
    const hard = codec.parseNativeRange('[1.0,2.0)');
    expect(hard.vers).toBe('vers:maven/>=1.0|<2.0');
    expect(hard.reversible).toBe(true);
    expect(hard.semanticLoss).toEqual([]);
    expect(codec.satisfies('1.5.0', '[1.0,2.0)')).toBe(true);
    expect(codec.satisfies('2.0.0', '[1.0,2.0)')).toBe(false);
    expect(codec.satisfies('1.0.0', '[1.0.0]')).toBe(true);

    const soft = codec.parseNativeRange('1.2.3');
    expect(soft.reversible).toBe(false);
    expect(soft.vers).toBeUndefined();
    expect(soft.semanticLoss[0]?.code).toBe('MAVEN_SOFT_REQUIREMENT');

    const multi = codec.parseNativeRange('[1.0,2.0),[3.0,4.0)');
    expect(multi.reversible).toBe(false);
    expect(multi.semanticLoss[0]?.code).toBe(
      'MAVEN_RANGE_DISJUNCTION_NOT_EXACTLY_REPRESENTABLE',
    );
  });

  it('captures gradle.lockfile resolved versions only', () => {
    const parsed = parseGradleLockfile(gradleLockText);
    expect(parsed.entries.length).toBeGreaterThanOrEqual(1);
    const capture = codec.translateLockResult(gradleLockText, {
      providerId: 'fixture',
      endpoint: 'https://fixtures.test',
      retrievedAt: '2026-08-02T00:00:00Z',
      evaluationTime: '2026-08-02T00:00:00Z',
      metadataDigest: { algorithm: 'sha256', value: '6'.repeat(64) },
    });
    expect(capture.format).toBe('gradle.lockfile');
    expect(
      capture.packages.find(
        (entry) => entry.exactPurl === 'pkg:maven/org.example/demo-tool@1.0.0',
      ),
    ).toMatchObject({
      exactPurl: 'pkg:maven/org.example/demo-tool@1.0.0',
      nativeCoordinate: 'org.example:demo-tool:1.0.0',
      resolved: '1.0.0',
    });
    expect(capture.semanticLoss[0]?.code).toBe('GRADLE_LOCK_RESOLVED_ONLY');
  });

  it('preserves classifier dependencies with semantic loss, never flattens', async () => {
    const catalog = JSON.parse(catalogBytes.toString()) as MavenCatalogEntry;
    const translated = await codec.translateMetadata(catalog, {
      providerId: 'fixture',
      endpoint: 'https://fixtures.test',
      retrievedAt: '2026-08-02T00:00:00Z',
      evaluationTime: '2026-08-02T00:00:00Z',
      metadataDigest: { algorithm: 'sha256', value: '7'.repeat(64) },
    });
    const classified = translated.instance.requirements.find(
      (requirement) =>
        requirement.id.includes('sources') ||
        JSON.stringify(requirement.raw).includes('sources'),
    );
    expect(classified?.expression).toMatchObject({
      type: 'package',
      purl: 'pkg:maven/org.example/demo-tool?classifier=sources',
    });
    expect(
      classified?.semanticLoss.some(
        (loss) => loss.code === 'MAVEN_DEPENDENCY_QUALIFIERS_PRESERVED',
      ),
    ).toBe(true);
    expect(translated.instance.artifacts[0]).toMatchObject({
      digest: {
        value:
          'dc6627d2e2704fc93499bc6a144ff589bcf140c54ec4585d0407357a956beb8d',
      },
      size: 28,
    });
  });
});

it('parses maven-metadata.xml fixture offline', () => {
  const metadata = parseMavenMetadataXml(metadataBytes.toString('utf8'));
  expect(metadata).toMatchObject({
    groupId: 'org.example',
    artifactId: 'demo-tool',
  });
  expect(metadata.versioning.versions).toEqual(['1.0.0-beta.1', '1.0.0']);
});

it('discovers Maven Central-style fixture metadata offline', async () => {
  const base = 'https://fixtures.openpacker.invalid/maven';
  const provider = new MavenRepositoryProvider(
    new FixtureHttpTransport(
      new Map([
        [
          `${base}/org/example/demo-tool/maven-metadata.xml`,
          [
            {
              status: 200,
              headers: { etag: '"maven-1"' },
              body: metadataBytes,
            },
            {
              status: 304,
              headers: { etag: '"maven-1"' },
              body: new Uint8Array(),
            },
          ],
        ],
        [
          `${base}/org/example/demo-tool/1.0.0/demo-tool-1.0.0.jar.catalog.json`,
          {
            status: 200,
            headers: { etag: '"maven-1"' },
            body: catalogBytes,
          },
        ],
        [
          `${base}/org/example/demo-tool/1.0.0-beta.1/demo-tool-1.0.0-beta.1.jar.catalog.json`,
          {
            status: 200,
            headers: { etag: '"maven-1"' },
            body: catalogBetaBytes,
          },
        ],
        [
          `${base}/org/example/demo-tool/1.0.0/demo-tool-1.0.0.jar`,
          { status: 200, headers: {}, body: archive },
        ],
      ]),
    ),
    { now: () => '2026-08-02T00:00:00Z' },
    base,
  );

  expect(await provider.enumerate('pkg:maven/org.example/demo-tool')).toEqual([
    'pkg:maven/org.example/demo-tool@1.0.0-beta.1',
    'pkg:maven/org.example/demo-tool@1.0.0',
  ]);
  // Revalidate via 304 path.
  await provider.enumerate('pkg:maven/org.example/demo-tool');

  const inspection = await provider.inspect(
    'pkg:maven/org.example/demo-tool@1.0.0',
  );
  expect(inspection.package.identity).toMatchObject({
    purlType: 'maven',
    namespace: 'org.example',
    name: 'demo-tool',
    exactPurl: 'pkg:maven/org.example/demo-tool@1.0.0',
  });
  expect(inspection.package.nativeSemantics.data).toMatchObject({
    installScriptsExecuted: false,
    packaging: 'jar',
  });
  expect(inspection.package.requirements[0]?.expression).toMatchObject({
    type: 'package',
    purl: 'pkg:maven/org.apache.commons/commons-lang3',
  });

  const artifact = await provider.fetchArtifactRecord(
    'pkg:maven/org.example/demo-tool@1.0.0',
  );
  expect(artifact.rawBody).toEqual(archive);
  expect(artifact.body).toMatchObject({
    digest: {
      value: 'dc6627d2e2704fc93499bc6a144ff589bcf140c54ec4585d0407357a956beb8d',
    },
    size: 28,
    locations: [
      {
        uri: `${base}/org/example/demo-tool/1.0.0/demo-tool-1.0.0.jar`,
      },
    ],
  });

  const snapshot = await provider.snapshot('2026-08-02T00:00:00Z');
  expect(snapshot.etag).toBe('"maven-1"');
  expect(snapshot.revision).toMatch(/^sha256:/);
  expect(snapshot.providerType).toBe('maven-repository');
});
