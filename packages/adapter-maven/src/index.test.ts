import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { FixtureHttpTransport } from '@openpacker/adapter-core';
import {
  MavenCodec,
  MavenRepositoryProvider,
  interpolateMavenExpression,
  isMavenSnapshotVersion,
  parseGradleLockfile,
  parseMavenChecksum,
  parseMavenMetadataXml,
  parseMavenPom,
  pomHasImportBom,
  resolvedPomCoordinates,
  resolvedPomDependencies,
  type MavenCatalogEntry,
} from './index.js';

const BASE = 'https://fixtures.openpacker.invalid/maven';
const DEMO_POM_URL = `${BASE}/org/example/demo-tool/1.0.0/demo-tool-1.0.0.pom`;
const DEMO_JAR_URL = `${BASE}/org/example/demo-tool/1.0.0/demo-tool-1.0.0.jar`;
const DEMO_SHA256_URL = `${DEMO_JAR_URL}.sha256`;
const DEMO_SHA1_URL = `${DEMO_JAR_URL}.sha1`;
const DEMO_CATALOG_URL = `${DEMO_JAR_URL}.catalog.json`;
const JAR_SHA256 =
  'dc6627d2e2704fc93499bc6a144ff589bcf140c54ec4585d0407357a956beb8d';

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function ok(body: Uint8Array | string, etag?: string) {
  return {
    status: 200,
    headers: etag === undefined ? {} : { etag },
    body: typeof body === 'string' ? utf8(body) : body,
  };
}

function mavenProvider(
  fixtures: ConstructorParameters<typeof FixtureHttpTransport>[0],
) {
  const transport = new FixtureHttpTransport(fixtures);
  return {
    transport,
    provider: new MavenRepositoryProvider(
      transport,
      { now: () => '2026-08-02T00:00:00Z' },
      BASE,
    ),
  };
}

function requestedUrls(transport: FixtureHttpTransport): string[] {
  return transport.requests.map((request) => request.url);
}

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
const stockPomText = await readFile(
  new URL(
    '../../../fixtures/catalogs/maven/demo-tool-1.0.0.pom',
    import.meta.url,
  ),
  'utf8',
);
const childPomText = await readFile(
  new URL(
    '../../../fixtures/catalogs/maven/child-tool-1.0.0.pom',
    import.meta.url,
  ),
  'utf8',
);
const orphanPomText = await readFile(
  new URL('../../../fixtures/catalogs/maven/orphan-tool.pom', import.meta.url),
  'utf8',
);
const sha256Sibling = await readFile(
  new URL(
    '../../../fixtures/catalogs/maven/demo-tool-1.0.0.jar.sha256',
    import.meta.url,
  ),
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

  it('rejects URL syntax in every repository path component', () => {
    for (const purl of [
      'pkg:maven/org%2F..%2Fadmin/demo@1.0.0',
      'pkg:maven/org.example/demo%3Fquery@1.0.0',
      'pkg:maven/org.example/demo@1.0.0%23fragment',
      'pkg:maven/org.example/demo@1.0.0?classifier=%2E%2E',
      'pkg:maven/org.example/demo@1.0.0?type=jar%2F..',
    ])
      expect(() => codec.canonicalizePurl(purl), purl).toThrow(/Maven/u);
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

it('rejects substituted Maven metadata identity', async () => {
  const base = 'https://fixtures.openpacker.invalid/maven';
  const provider = new MavenRepositoryProvider(
    new FixtureHttpTransport(
      new Map([
        [
          `${base}/org/example/demo-tool/maven-metadata.xml`,
          {
            status: 200,
            headers: {},
            body: new TextEncoder().encode(
              metadataBytes
                .toString('utf8')
                .replace(
                  '<artifactId>demo-tool</artifactId>',
                  '<artifactId>other-tool</artifactId>',
                ),
            ),
          },
        ],
      ]),
    ),
    { now: () => '2026-08-02T00:00:00Z' },
    base,
  );
  await expect(
    provider.enumerate('pkg:maven/org.example/demo-tool'),
  ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_METADATA' });
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
          `${base}/org/example/demo-tool/1.0.0/demo-tool-1.0.0.pom`,
          {
            status: 200,
            headers: { etag: '"maven-1"' },
            body: utf8(stockPomText),
          },
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
  expect(
    inspection.package.requirements.some(
      (requirement) =>
        requirement.expression.type === 'package' &&
        requirement.expression.purl ===
          'pkg:maven/org.apache.commons/commons-lang3',
    ),
  ).toBe(true);

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

describe('Maven POM parser', () => {
  it('reads stock POM GAV, properties, exclusions, optional, and profiles', () => {
    const pom = parseMavenPom(stockPomText);
    expect(resolvedPomCoordinates(pom)).toMatchObject({
      groupId: 'org.example',
      artifactId: 'demo-tool',
      version: '1.0.0',
      packaging: 'jar',
      complete: true,
    });
    const { included, skippedUnresolved } = resolvedPomDependencies(pom);
    expect(
      included.map(
        (dependency) => `${dependency.groupId}:${dependency.artifactId}`,
      ),
    ).toEqual([
      'org.apache.commons:commons-lang3',
      'com.google.guava:guava',
      'org.junit.jupiter:junit-jupiter',
      'org.example:demo-tool',
    ]);
    expect(included[0]).toMatchObject({
      version: '[3.12.0,4.0.0)',
    });
    expect(included[1]?.exclusions).toEqual([
      { groupId: 'com.google.code.findbugs', artifactId: 'jsr305' },
    ]);
    expect(included[2]).toMatchObject({
      version: '5.10.2',
      scope: 'test',
    });
    expect(included[3]).toMatchObject({
      classifier: 'sources',
      optional: true,
      scope: 'provided',
    });
    expect(skippedUnresolved).toEqual([
      expect.objectContaining({
        artifactId: 'missing-prop-lib',
        version: '${not.defined.in.this.pom}',
      }),
    ]);
    expect(pom.profileDependencies).toEqual([
      expect.objectContaining({ artifactId: 'profile-only', version: '9.9.9' }),
    ]);
  });

  it('records parent and import BOM without resolving them', () => {
    const pom = parseMavenPom(childPomText);
    expect(pom.parent).toEqual({
      groupId: 'org.example',
      artifactId: 'parent-bom',
      version: '2.0.0',
    });
    expect(pomHasImportBom(pom)).toBe(true);
    const { included, skippedUnresolved } = resolvedPomDependencies(pom);
    expect(included).toEqual([
      expect.objectContaining({
        groupId: 'org.slf4j',
        artifactId: 'slf4j-api',
        version: '2.0.9',
      }),
    ]);
    expect(skippedUnresolved).toEqual([
      expect.objectContaining({ artifactId: 'managed-from-parent' }),
    ]);
  });

  it('does not complete a child GAV from parent coordinates', () => {
    const pom = parseMavenPom(orphanPomText);
    expect(resolvedPomCoordinates(pom)).toMatchObject({
      artifactId: 'orphan-tool',
      complete: false,
    });
    expect(resolvedPomCoordinates(pom).groupId).toBeUndefined();
    expect(resolvedPomCoordinates(pom).version).toBeUndefined();
  });

  it('refuses a missing project document and interpolates defined properties', () => {
    expect(() => parseMavenPom('<not-a-pom/>')).toThrow(/project document/u);
    expect(
      interpolateMavenExpression('${commons.version}', {
        'commons.version': '[3.12.0,4.0.0)',
      }),
    ).toEqual({ value: '[3.12.0,4.0.0)', unresolved: false });
    expect(interpolateMavenExpression('${missing}', { other: '1' })).toEqual({
      value: '${missing}',
      unresolved: true,
    });
    expect(isMavenSnapshotVersion('1.0.0-SNAPSHOT')).toBe(true);
    expect(isMavenSnapshotVersion('1.0.0')).toBe(false);
    expect(parseMavenChecksum(`${JAR_SHA256}  demo-tool-1.0.0.jar\n`, 64)).toBe(
      JAR_SHA256,
    );
  });
});

describe('Maven stock-repository inspect', () => {
  it('inspects from POM and sha256 sibling without catalog.json', async () => {
    const { transport, provider } = mavenProvider(
      new Map([
        [DEMO_POM_URL, ok(stockPomText)],
        [DEMO_SHA256_URL, ok(sha256Sibling)],
        [DEMO_JAR_URL, ok(archive)],
      ]),
    );

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
      packaging: 'jar',
      openpackerSha256: JAR_SHA256,
      packageUrl: DEMO_JAR_URL,
    });
    const purls = inspection.package.requirements.map((requirement) =>
      requirement.expression.type === 'package'
        ? requirement.expression.purl
        : undefined,
    );
    expect(purls).toContain('pkg:maven/org.apache.commons/commons-lang3');
    expect(purls).toContain('pkg:maven/com.google.guava/guava');
    expect(purls).toContain('pkg:maven/org.junit.jupiter/junit-jupiter');
    expect(purls).toContain(
      'pkg:maven/org.example/demo-tool?classifier=sources',
    );
    expect(purls.some((purl) => purl?.includes('missing-prop-lib'))).toBe(
      false,
    );
    expect(purls.some((purl) => purl?.includes('profile-only'))).toBe(false);
    expect(
      inspection.package.requirements.some(
        (requirement) =>
          requirement.expression.type === 'package' &&
          requirement.expression.vers === undefined &&
          JSON.stringify(requirement.raw).includes('${'),
      ),
    ).toBe(false);
    expect(inspection.package.semanticLoss.map((loss) => loss.code)).toEqual(
      expect.arrayContaining([
        'MAVEN_PROFILES_NATIVE_ONLY',
        'MAVEN_DEPENDENCY_VERSION_UNRESOLVED',
      ]),
    );
    expect(
      inspection.package.requirements.some((requirement) =>
        requirement.semanticLoss.some(
          (loss) => loss.code === 'MAVEN_EXCLUSIONS_NATIVE_ONLY',
        ),
      ),
    ).toBe(true);
    expect(requestedUrls(transport)).toContain(DEMO_POM_URL);
    expect(requestedUrls(transport)).toContain(DEMO_SHA256_URL);
    // Overlay is probed; 404/missing fixture is not an inspect failure.
    expect(requestedUrls(transport)).toContain(DEMO_CATALOG_URL);

    const artifact = await provider.fetchArtifactRecord(
      'pkg:maven/org.example/demo-tool@1.0.0',
    );
    expect(artifact.body).toMatchObject({
      digest: { value: JAR_SHA256 },
      size: 28,
    });
  });

  it('does not require catalog.json when the POM is missing', async () => {
    const { transport, provider } = mavenProvider(new Map());
    await expect(
      provider.inspect('pkg:maven/org.example/demo-tool@1.0.0'),
    ).rejects.toMatchObject({ code: 'VERSION_NOT_FOUND' });
    expect(requestedUrls(transport)).toEqual([DEMO_POM_URL]);
    expect(requestedUrls(transport)).not.toContain(DEMO_CATALOG_URL);
  });

  it('rejects a catalog overlay whose GAV does not match the POM', async () => {
    const { provider } = mavenProvider(
      new Map([
        [DEMO_POM_URL, ok(stockPomText)],
        [
          DEMO_CATALOG_URL,
          ok(
            catalogBytes
              .toString('utf8')
              .replace('"groupId": "org.example"', '"groupId": "org.other"'),
          ),
        ],
      ]),
    );
    await expect(
      provider.inspect('pkg:maven/org.example/demo-tool@1.0.0'),
    ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_METADATA' });
  });

  it('rejects a mismatching catalog overlay even when a sha256 sibling is present', async () => {
    const { transport, provider } = mavenProvider(
      new Map([
        [DEMO_POM_URL, ok(stockPomText)],
        [DEMO_SHA256_URL, ok(`${JAR_SHA256}  demo-tool-1.0.0.jar\n`)],
        [
          DEMO_CATALOG_URL,
          ok(
            catalogBytes
              .toString('utf8')
              .replace('"groupId": "org.example"', '"groupId": "org.other"'),
          ),
        ],
      ]),
    );
    await expect(
      provider.inspect('pkg:maven/org.example/demo-tool@1.0.0'),
    ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_METADATA' });
    expect(requestedUrls(transport)).toContain(DEMO_CATALOG_URL);
  });

  it('uses catalog overlay sha256 when the sidecar is present', async () => {
    const { transport, provider } = mavenProvider(
      new Map([
        [DEMO_POM_URL, ok(stockPomText)],
        [DEMO_CATALOG_URL, ok(catalogBytes)],
        [DEMO_JAR_URL, ok(archive)],
      ]),
    );
    const inspection = await provider.inspect(
      'pkg:maven/org.example/demo-tool@1.0.0',
    );
    expect(inspection.package.artifacts[0]).toMatchObject({
      digest: { value: JAR_SHA256 },
      size: 28,
      locations: [{ uri: DEMO_JAR_URL }],
    });
    expect(requestedUrls(transport)).toContain(DEMO_CATALOG_URL);
  });

  it('records parent and BOM loss without fetching those coordinates', async () => {
    const childPomUrl = `${BASE}/org/example/child-tool/1.0.0/child-tool-1.0.0.pom`;
    const parentPomUrl = `${BASE}/org/example/parent-bom/2.0.0/parent-bom-2.0.0.pom`;
    const bomPomUrl = `${BASE}/org/springframework/boot/spring-boot-dependencies/3.2.0/spring-boot-dependencies-3.2.0.pom`;
    const { transport, provider } = mavenProvider(
      new Map([[childPomUrl, ok(childPomText)]]),
    );
    const inspection = await provider.inspect(
      'pkg:maven/org.example/child-tool@1.0.0',
    );
    expect(inspection.package.identity.exactPurl).toBe(
      'pkg:maven/org.example/child-tool@1.0.0',
    );
    expect(inspection.package.semanticLoss.map((loss) => loss.code)).toEqual(
      expect.arrayContaining([
        'MAVEN_PARENT_NOT_INLINED',
        'MAVEN_BOM_NOT_INLINED',
        'MAVEN_DEPENDENCY_VERSION_UNRESOLVED',
      ]),
    );
    const purls = inspection.package.requirements.map((requirement) =>
      requirement.expression.type === 'package'
        ? requirement.expression.purl
        : undefined,
    );
    expect(purls).toEqual(['pkg:maven/org.slf4j/slf4j-api']);
    expect(requestedUrls(transport)).toEqual(
      expect.arrayContaining([childPomUrl]),
    );
    expect(requestedUrls(transport)).not.toContain(parentPomUrl);
    expect(requestedUrls(transport)).not.toContain(bomPomUrl);
  });

  it('fail-closes when the POM GAV cannot be completed without a parent', async () => {
    const { transport, provider } = mavenProvider(
      new Map([
        [
          `${BASE}/org/example/orphan-tool/1.0.0/orphan-tool-1.0.0.pom`,
          ok(orphanPomText),
        ],
      ]),
    );
    await expect(
      provider.inspect('pkg:maven/org.example/orphan-tool@1.0.0'),
    ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_METADATA' });
    expect(
      requestedUrls(transport).some((url) => url.includes('parent-bom')),
    ).toBe(false);
  });

  it('refuses SNAPSHOT inspect without a unique snapshot resolver', async () => {
    const { transport, provider } = mavenProvider(new Map());
    await expect(
      provider.inspect('pkg:maven/org.example/demo-tool@1.0.0-SNAPSHOT'),
    ).rejects.toMatchObject({ code: 'VERSION_NOT_FOUND' });
    expect(requestedUrls(transport)).toEqual([]);
  });

  it('snapshots canonical stock inspect shape', async () => {
    const { provider } = mavenProvider(
      new Map([
        [DEMO_POM_URL, ok(stockPomText)],
        [DEMO_SHA256_URL, ok(sha256Sibling)],
      ]),
    );
    const inspection = await provider.inspect(
      'pkg:maven/org.example/demo-tool@1.0.0',
    );
    const snapshot = {
      identity: {
        exactPurl: inspection.package.identity.exactPurl,
        namespace: inspection.package.identity.namespace,
        name: inspection.package.identity.name,
      },
      requirements: inspection.package.requirements.map((requirement) => ({
        purl:
          requirement.expression.type === 'package'
            ? requirement.expression.purl
            : undefined,
        vers:
          requirement.expression.type === 'package'
            ? requirement.expression.vers
            : undefined,
        kind: requirement.kind,
        optional: requirement.optional,
        native: requirement.nativeSemantics?.data,
      })),
      native: inspection.package.nativeSemantics.data,
      loss: inspection.package.semanticLoss.map((loss) => loss.code).sort(),
      warnings: inspection.warnings.map((warning) => warning.code).sort(),
    };
    await expect(`${JSON.stringify(snapshot, null, 2)}\n`).toMatchFileSnapshot(
      '__snapshots__/stock-inspect.snap',
    );
  });
});
