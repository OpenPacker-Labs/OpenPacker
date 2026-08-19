import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import {
  FixtureHttpTransport,
  type HttpTransport,
} from '@openpacker/adapter-core';
import {
  NugetCodec,
  NugetV3Provider,
  type NugetRegistrationIndex,
  parseNugetServiceIndex,
} from './index.js';

const serviceBytes = await readFile(
  new URL(
    '../../../fixtures/catalogs/nuget/service-index.json',
    import.meta.url,
  ),
);
const registrationBytes = await readFile(
  new URL(
    '../../../fixtures/catalogs/nuget/registration-demo.tool.json',
    import.meta.url,
  ),
);
const registrationPageBytes = await readFile(
  new URL(
    '../../../fixtures/catalogs/nuget/registration-demo.tool-page-1.json',
    import.meta.url,
  ),
);
const archive = await readFile(
  new URL(
    '../../../fixtures/catalogs/nuget/demo.tool.1.0.0.nupkg',
    import.meta.url,
  ),
);

describe('NuGet service index parser', () => {
  it('accepts the shared fixture', () => {
    expect(
      parseNugetServiceIndex(serviceBytes).resources.length,
    ).toBeGreaterThan(0);
  });

  it.each([
    new TextEncoder().encode(
      JSON.stringify({ resources: [], padding: 'x'.repeat(256 * 1024) }),
    ),
    new TextEncoder().encode(
      JSON.stringify({
        resources: [],
        nested: Array.from({ length: 18 }).reduce((value) => ({ value }), {}),
      }),
    ),
    new TextEncoder().encode(
      JSON.stringify({
        resources: Array.from({ length: 257 }, (_, index) => ({
          '@id': `https://api.nuget.org/${index}`,
          '@type': 'PackageBaseAddress/3.0.0',
        })),
      }),
    ),
  ])('rejects oversized or structurally excessive service indices', (bytes) => {
    expect(() => parseNugetServiceIndex(bytes)).toThrow();
  });

  it('rejects unsafe resource endpoints', () => {
    const bytes = new TextEncoder().encode(
      JSON.stringify({
        resources: [
          {
            '@id': 'http://api.nuget.org/v3/',
            '@type': 'PackageBaseAddress/3.0.0',
          },
        ],
      }),
    );
    expect(() => parseNugetServiceIndex(bytes)).toThrow(/must be HTTPS/u);
  });
});

describe('NuGet codec', () => {
  const codec = new NugetCodec();
  it('normalizes four-part versions and uses NuGet interval semantics', () => {
    expect(codec.canonicalizePurl('pkg:nuget/Newtonsoft.Json@01.0.0.0')).toBe(
      'pkg:nuget/newtonsoft.json@1.0.0',
    );
    expect(codec.satisfies('1.5.0', '[1.0,2.0)')).toBe(true);
    expect(codec.satisfies('2.0.0', '[1.0,2.0)')).toBe(false);
    expect(codec.satisfies('2.5.0', '2.0')).toBe(true);
    expect(codec.satisfies('3.0.0', '2.*')).toBe(false);
  });

  it('rejects decoded registration path traversal IDs', () => {
    expect(() =>
      codec.canonicalizePurl('pkg:nuget/%2E%2E%2Fadmin@1.0.0'),
    ).toThrow(/package ID/u);
  });

  it('captures target-framework lock data', () => {
    const capture = codec.translateLockResult(
      {
        format: 'packages.lock.json',
        data: {
          version: 1,
          dependencies: {
            'net8.0': {
              Demo: {
                type: 'Direct',
                requested: '[1.0,2.0)',
                resolved: '1.5.0',
                contentHash: 'sha512-fixture',
                dependencies: { Child: '[2.0]' },
              },
            },
          },
        },
      },
      {
        providerId: 'fixture',
        endpoint: 'https://fixtures.test',
        retrievedAt: '2026-08-02T00:00:00Z',
        evaluationTime: '2026-08-02T00:00:00Z',
        metadataDigest: { algorithm: 'sha256', value: '5'.repeat(64) },
      },
    );
    expect(capture.packages[0]).toMatchObject({
      exactPurl: 'pkg:nuget/demo@1.5.0',
      dependencies: { Child: '[2.0]' },
    });
  });
});

it('discovers registration metadata through a deterministic NuGet v3 service index', async () => {
  const registration = JSON.parse(
    registrationBytes.toString(),
  ) as NugetRegistrationIndex;
  expect(registration.items[0]).toMatchObject({ count: 2 });
  const provider = new NugetV3Provider(
    new FixtureHttpTransport(
      new Map([
        [
          'https://fixtures.openpacker.invalid/nuget/service-index.json',
          {
            status: 200,
            headers: {},
            body: serviceBytes,
          },
        ],
        [
          'https://fixtures.openpacker.invalid/nuget/registration/demo.tool/index.json',
          [
            {
              status: 200,
              headers: { etag: '"nuget-1"' },
              body: registrationBytes,
            },
            {
              status: 304,
              headers: { etag: '"nuget-1"' },
              body: new Uint8Array(),
            },
          ],
        ],
        [
          'https://fixtures.openpacker.invalid/nuget/registration/demo.tool/page/1.json',
          {
            status: 200,
            headers: { etag: '"nuget-1"' },
            body: registrationPageBytes,
          },
        ],
        [
          'https://fixtures.openpacker.invalid/nuget/flat/demo.tool/1.0.0/demo.tool.1.0.0.nupkg',
          { status: 200, headers: {}, body: archive },
        ],
      ]),
    ),
    { now: () => '2026-08-02T00:00:00Z' },
    'https://fixtures.openpacker.invalid/nuget/service-index.json',
  );
  expect(await provider.enumerate('pkg:nuget/Demo.Tool')).toEqual([
    'pkg:nuget/demo.tool@1.0.0-beta.1',
    'pkg:nuget/demo.tool@1.0.0',
  ]);
  const inspection = await provider.inspect('pkg:nuget/demo.tool@1.0.0');
  expect(inspection.package.requirements[0]?.expression).toMatchObject({
    type: 'conditional',
    when: { path: 'variables.tfm', value: 'net8.0' },
  });
  expect(inspection.package.nativeSemantics.data).toMatchObject({
    installScriptsExecuted: false,
  });
  const artifact = await provider.fetchArtifactRecord(
    'pkg:nuget/demo.tool@1.0.0',
  );
  expect(artifact.rawBody).toEqual(archive);
  expect(artifact.body).toMatchObject({
    digest: {
      value: '7dbdc6ab22fd145119dafac3c5529232faf88f89c6353ec8d4f35d1d81ce9959',
    },
    size: 33,
    locations: [
      {
        uri: 'https://fixtures.openpacker.invalid/nuget/flat/demo.tool/1.0.0/demo.tool.1.0.0.nupkg',
      },
    ],
  });
  const snapshot = await provider.snapshot('2026-08-02T00:00:00Z');
  expect(snapshot.etag).toBe('"nuget-1"');
  expect(snapshot.revision).toMatch(/^sha256:/);
});

it('bounds aggregate NuGet registration bytes before parsing', async () => {
  const transport: HttpTransport = {
    async request(request) {
      if (request.url.endsWith('/service-index.json'))
        return {
          status: 200,
          headers: {},
          body: serviceBytes,
          url: request.url,
        };
      return {
        status: 200,
        headers: {},
        body: { byteLength: 64 * 1024 * 1024 + 1 } as Uint8Array,
        url: request.url,
      };
    },
  };
  const provider = new NugetV3Provider(
    transport,
    { now: () => '2026-08-02T00:00:00Z' },
    'https://fixtures.openpacker.invalid/nuget/service-index.json',
  );
  await expect(provider.enumerate('pkg:nuget/demo.tool')).rejects.toMatchObject(
    { code: 'UPSTREAM_RESPONSE_TOO_LARGE' },
  );
});
