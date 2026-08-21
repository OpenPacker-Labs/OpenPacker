import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { FixtureHttpTransport } from '@openpacker/adapter-core';
import { MavenRepositoryProvider } from './index.js';

const BASE = 'https://fixtures.openpacker.invalid/maven';
const POM_URL = `${BASE}/org/example/demo-tool/1.0.0/demo-tool-1.0.0.pom`;
const JAR_URL = `${BASE}/org/example/demo-tool/1.0.0/demo-tool-1.0.0.jar`;
const SHA256_URL = `${JAR_URL}.sha256`;
const SHA1_URL = `${JAR_URL}.sha1`;
const CATALOG_URL = `${JAR_URL}.catalog.json`;
const PURL = 'pkg:maven/org.example/demo-tool@1.0.0';
const JAR_SHA256 =
  'dc6627d2e2704fc93499bc6a144ff589bcf140c54ec4585d0407357a956beb8d';

const pom = await readFile(
  new URL(
    '../../../fixtures/catalogs/maven/demo-tool-1.0.0.pom',
    import.meta.url,
  ),
  'utf8',
);
const sha256Sibling = await readFile(
  new URL(
    '../../../fixtures/catalogs/maven/demo-tool-1.0.0.jar.sha256',
    import.meta.url,
  ),
);
const catalog = await readFile(
  new URL(
    '../../../fixtures/catalogs/maven/catalog-org.example-demo-tool-1.0.0.json',
    import.meta.url,
  ),
  'utf8',
);

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function ok(body: Uint8Array | string) {
  return {
    status: 200,
    headers: {},
    body: typeof body === 'string' ? utf8(body) : body,
  };
}

function providerFor(
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

const validLayout = () =>
  new Map([
    [POM_URL, ok(pom)],
    [SHA256_URL, ok(sha256Sibling)],
  ]);

/**
 * Mutation coverage for stock Maven inspect. A surviving mutant would mean
 * inspect invents a digest, silently accepts the wrong GAV, or treats a
 * missing POM as an empty package.
 */
describe('Maven inspect mutation coverage', () => {
  it('accepts the unmutated stock layout', async () => {
    const { provider } = providerFor(validLayout());
    const inspection = await provider.inspect(PURL);
    expect(inspection.package.identity.exactPurl).toBe(PURL);
    expect(inspection.package.nativeSemantics.data).toMatchObject({
      openpackerSha256: JAR_SHA256,
    });
  });

  it('kills digest, identity, and completeness mutants', async () => {
    const jarSha1 = createHash('sha1')
      .update('openpacker-maven-fixture-v1\n')
      .digest('hex');
    const mutants: {
      name: string;
      fixtures: ConstructorParameters<typeof FixtureHttpTransport>[0];
      expect: (run: () => Promise<unknown>) => Promise<void>;
    }[] = [
      {
        name: 'drop-sha256-sibling',
        fixtures: new Map([[POM_URL, ok(pom)]]),
        expect: async (run) => {
          const inspection = (await run()) as Awaited<
            ReturnType<MavenRepositoryProvider['inspect']>
          >;
          const data = inspection.package.nativeSemantics.data as {
            openpackerSha256?: string;
          };
          expect(data.openpackerSha256).toBeUndefined();
          expect(inspection.package.artifacts).toEqual([]);
          expect(
            inspection.package.semanticLoss.some(
              (loss) => loss.code === 'MAVEN_SHA256_NOT_SUPPLIED',
            ),
          ).toBe(true);
        },
      },
      {
        name: 'sha1-sibling-not-promoted-to-sha256',
        fixtures: new Map([
          [POM_URL, ok(pom)],
          [SHA1_URL, ok(`${jarSha1}  demo-tool-1.0.0.jar\n`)],
        ]),
        expect: async (run) => {
          const inspection = (await run()) as Awaited<
            ReturnType<MavenRepositoryProvider['inspect']>
          >;
          const data = inspection.package.nativeSemantics.data as {
            openpackerSha256?: string;
            sha1?: string;
          };
          expect(data.openpackerSha256).toBeUndefined();
          expect(data.sha1).toBe(jarSha1);
          expect(
            inspection.package.semanticLoss.some(
              (loss) => loss.code === 'MAVEN_SHA1_NOT_SHA256',
            ),
          ).toBe(true);
        },
      },
      {
        name: 'corrupt-sha256-sidecar',
        fixtures: new Map([
          [POM_URL, ok(pom)],
          [SHA256_URL, ok('not-a-digest\n')],
        ]),
        expect: async (run) => {
          await expect(run()).rejects.toMatchObject({
            code: 'INVALID_PROVIDER_METADATA',
          });
        },
      },
      {
        name: 'swap-groupId',
        fixtures: new Map([
          [
            POM_URL,
            ok(
              pom.replace(
                '<groupId>org.example</groupId>',
                '<groupId>org.other</groupId>',
              ),
            ),
          ],
          [SHA256_URL, ok(sha256Sibling)],
        ]),
        expect: async (run) => {
          await expect(run()).rejects.toMatchObject({
            code: 'INVALID_PROVIDER_METADATA',
          });
        },
      },
      {
        name: 'corrupt-artifactId',
        fixtures: new Map([
          [
            POM_URL,
            ok(
              pom.replace(
                '<artifactId>demo-tool</artifactId>',
                '<artifactId>other-tool</artifactId>',
              ),
            ),
          ],
        ]),
        expect: async (run) => {
          await expect(run()).rejects.toMatchObject({
            code: 'INVALID_PROVIDER_METADATA',
          });
        },
      },
      {
        name: 'catalog-overlay-wrong-gav',
        fixtures: new Map([
          [POM_URL, ok(pom)],
          [
            CATALOG_URL,
            ok(
              catalog.replace(
                '"groupId": "org.example"',
                '"groupId": "org.other"',
              ),
            ),
          ],
        ]),
        expect: async (run) => {
          await expect(run()).rejects.toMatchObject({
            code: 'INVALID_PROVIDER_METADATA',
          });
        },
      },
      {
        name: 'unresolved-property-not-star',
        fixtures: validLayout(),
        expect: async (run) => {
          const inspection = (await run()) as Awaited<
            ReturnType<MavenRepositoryProvider['inspect']>
          >;
          for (const requirement of inspection.package.requirements) {
            expect(JSON.stringify(requirement.raw)).not.toContain('${');
            if (requirement.expression.type === 'package') {
              expect(requirement.expression.purl).not.toContain('${');
              expect(requirement.expression.vers).not.toBe('vers:maven/*');
            }
          }
        },
      },
    ];

    for (const mutant of mutants) {
      const { provider, transport } = providerFor(mutant.fixtures);
      await mutant.expect(() => provider.inspect(PURL));
      expect(
        transport.requests.some((request) =>
          request.url.includes('parent-bom'),
        ),
        mutant.name,
      ).toBe(false);
    }
  });
});
