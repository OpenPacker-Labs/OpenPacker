import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { FixtureHttpTransport } from '@openpacker/adapter-core';
import {
  GolangCodec,
  GolangProxyProvider,
  encodeGoModulePath,
} from './index.js';

const clock = { now: () => '2026-08-02T00:00:00Z' };
const endpoint = 'https://fixtures.test';
const codec = new GolangCodec();

const listBytes = await readFile(
  new URL('../../../fixtures/catalogs/golang/list.txt', import.meta.url),
);
const infoBytes = await readFile(
  new URL('../../../fixtures/catalogs/golang/v1.0.0.info', import.meta.url),
);
const modBytes = await readFile(
  new URL('../../../fixtures/catalogs/golang/v1.0.0.mod', import.meta.url),
);
const archive = await readFile(
  new URL(
    '../../../fixtures/catalogs/golang/demo-zstd-v1.0.0.zip',
    import.meta.url,
  ),
);
const missingModBytes = await readFile(
  new URL('../../../fixtures/catalogs/golang/not-found.mod', import.meta.url),
);

const DEMO_ZSTD = 'github.com/openpacker/demo-zstd';
const DEMO_ZSTD_PURL = 'pkg:golang/github.com/openpacker/demo-zstd';

function proxyUrls(modulePath: string) {
  const encoded = encodeGoModulePath(modulePath);
  const root = `${endpoint}/${encoded}`;
  return {
    encoded,
    list: `${root}/@v/list`,
    info: (version: string) => `${root}/@v/${version}.info`,
    mod: (version: string) => `${root}/@v/${version}.mod`,
    zip: (version: string) => `${root}/@v/${version}.zip`,
  };
}

function providerFor(
  fixtures: ConstructorParameters<typeof FixtureHttpTransport>[0],
) {
  const transport = new FixtureHttpTransport(fixtures);
  return {
    transport,
    provider: new GolangProxyProvider(transport, clock, endpoint),
  };
}

function listedVersionsFromFixture(): string[] {
  return listBytes
    .toString('utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((version) => codec.parseNativeVersion(version).normalized)
    .sort((left, right) => codec.compareNativeVersions(left, right));
}

describe('Go module proxy provider e2e (offline fixtures)', () => {
  it('enumerates versions from @v/list in codec order', async () => {
    const urls = proxyUrls(DEMO_ZSTD);
    const { provider, transport } = providerFor(
      new Map([
        [
          urls.list,
          { status: 200, headers: { etag: '"golang-1"' }, body: listBytes },
        ],
      ]),
    );

    const enumerated = await provider.enumerate(DEMO_ZSTD_PURL);
    expect(enumerated).toEqual(
      listedVersionsFromFixture().map(
        (version) => `${DEMO_ZSTD_PURL}@${version}`,
      ),
    );
    expect(transport.requests.map((request) => request.url)).toEqual([
      urls.list,
    ]);
  });

  it('inspects requirements from .mod require rather than an empty list', async () => {
    const urls = proxyUrls(DEMO_ZSTD);
    const { provider, transport } = providerFor(
      new Map([
        [urls.info('v1.0.0'), { status: 200, headers: {}, body: infoBytes }],
        [urls.mod('v1.0.0'), { status: 200, headers: {}, body: modBytes }],
      ]),
    );

    const inspection = await provider.inspect(`${DEMO_ZSTD_PURL}@v1.0.0`);
    expect(inspection.package.identity.exactPurl).toBe(
      `${DEMO_ZSTD_PURL}@v1.0.0`,
    );
    expect(inspection.package.requirements).not.toEqual([]);
    expect(
      inspection.package.requirements.map((req) => req.expression),
    ).toEqual([
      expect.objectContaining({
        type: 'package',
        purl: 'pkg:golang/github.com/openpacker/cfg-if',
      }),
    ]);
    expect(inspection.package.nativeSemantics.data).toMatchObject({
      path: DEMO_ZSTD,
      go: '1.22',
      requires: [
        expect.objectContaining({
          path: 'github.com/openpacker/cfg-if',
          version: 'v1.0.0',
        }),
      ],
      downloadUrl: urls.zip('v1.0.0'),
    });
    expect(inspection.warnings).toEqual([]);
    expect(transport.requests.map((request) => request.url)).toEqual([
      urls.info('v1.0.0'),
      urls.mod('v1.0.0'),
    ]);
  });

  it('does not fabricate a zip sha256 at inspect time', async () => {
    const urls = proxyUrls(DEMO_ZSTD);
    const { provider } = providerFor(
      new Map([
        [urls.info('v1.0.0'), { status: 200, headers: {}, body: infoBytes }],
        [urls.mod('v1.0.0'), { status: 200, headers: {}, body: modBytes }],
      ]),
    );

    const inspection = await provider.inspect(`${DEMO_ZSTD_PURL}@v1.0.0`);
    expect(inspection.package.artifacts).toEqual([]);
    expect(
      inspection.package.semanticLoss.map((loss) => loss.code),
    ).not.toContain('GOLANG_H1_NOT_SHA256');
  });

  it('hashes fetchArtifactRecord zip bytes to sha256 of the fixture', async () => {
    const urls = proxyUrls(DEMO_ZSTD);
    const { provider, transport } = providerFor(
      new Map([
        [urls.info('v1.0.0'), { status: 200, headers: {}, body: infoBytes }],
        [urls.mod('v1.0.0'), { status: 200, headers: {}, body: modBytes }],
        [urls.zip('v1.0.0'), { status: 200, headers: {}, body: archive }],
      ]),
    );

    const artifact = await provider.fetchArtifactRecord(
      `${DEMO_ZSTD_PURL}@v1.0.0`,
    );
    const digest = createHash('sha256').update(archive).digest('hex');
    expect(artifact.rawBody).toEqual(archive);
    expect(artifact.body).toMatchObject({
      digest: { algorithm: 'sha256', value: digest },
      size: archive.byteLength,
      mediaType: 'application/zip',
    });
    expect(transport.requests.map((request) => request.url)).toContain(
      urls.zip('v1.0.0'),
    );
  });

  it('uses encodeGoModulePath for uppercase module path segments', async () => {
    const modulePath = 'github.com/OpenPacker/Demo';
    const urls = proxyUrls(modulePath);
    expect(urls.encoded).toBe('github.com/!open!packer/!demo');
    const { provider, transport } = providerFor(
      new Map([
        [urls.list, { status: 200, headers: {}, body: listBytes }],
        [urls.info('v1.0.0'), { status: 200, headers: {}, body: infoBytes }],
        [urls.mod('v1.0.0'), { status: 200, headers: {}, body: modBytes }],
      ]),
    );

    await provider.enumerate('pkg:golang/github.com/OpenPacker/Demo');
    await provider.inspect('pkg:golang/github.com/OpenPacker/Demo@v1.0.0');
    const requested = transport.requests.map((request) => request.url);
    expect(requested).toEqual([
      urls.list,
      urls.info('v1.0.0'),
      urls.mod('v1.0.0'),
    ]);
    expect(requested.every((url) => url.includes(urls.encoded))).toBe(true);
    expect(requested.some((url) => url.includes('OpenPacker'))).toBe(false);
  });

  it.each([404, 410])(
    'succeeds with GOLANG_MOD_NOT_AVAILABLE and no fabricated requires when .mod is %s',
    async (status) => {
      const urls = proxyUrls(DEMO_ZSTD);
      const { provider } = providerFor(
        new Map([
          [urls.info('v1.0.0'), { status: 200, headers: {}, body: infoBytes }],
          [urls.mod('v1.0.0'), { status, headers: {}, body: missingModBytes }],
        ]),
      );

      const inspection = await provider.inspect(`${DEMO_ZSTD_PURL}@v1.0.0`);
      expect(inspection.package.requirements).toEqual([]);
      expect(
        (inspection.package.nativeSemantics.data as { requires: unknown })
          .requires,
      ).toEqual([]);
      expect(inspection.warnings).toEqual([
        expect.objectContaining({ code: 'GOLANG_MOD_NOT_AVAILABLE' }),
      ]);
      expect(inspection.warnings[0]?.message).toMatch(/unknown, not empty/i);
    },
  );

  it.each([500, 503])(
    'fails closed with UPSTREAM_UNAVAILABLE when .mod returns %s',
    async (status) => {
      const urls = proxyUrls(DEMO_ZSTD);
      const { provider } = providerFor(
        new Map([
          [urls.info('v1.0.0'), { status: 200, headers: {}, body: infoBytes }],
          [urls.mod('v1.0.0'), { status, headers: {}, body: missingModBytes }],
        ]),
      );

      await expect(
        provider.inspect(`${DEMO_ZSTD_PURL}@v1.0.0`),
      ).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
    },
  );

  it('fails VERSION_NOT_FOUND when .info is missing', async () => {
    const urls = proxyUrls(DEMO_ZSTD);
    const { provider } = providerFor(
      new Map([
        [
          urls.info('v1.0.0'),
          { status: 404, headers: {}, body: missingModBytes },
        ],
      ]),
    );

    await expect(
      provider.inspect(`${DEMO_ZSTD_PURL}@v1.0.0`),
    ).rejects.toMatchObject({ code: 'VERSION_NOT_FOUND' });
  });
});
