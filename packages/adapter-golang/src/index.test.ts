import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { FixtureHttpTransport } from '@openpacker/adapter-core';
import {
  GolangCodec,
  GolangProxyProvider,
  encodeGoModulePath,
  parseExactBuildConstraint,
  parseGoMod,
  parseGoSum,
  type GolangModuleVersionMetadata,
} from './index.js';

const metadataBytes = await readFile(
  new URL(
    '../../../fixtures/catalogs/golang/module-metadata.json',
    import.meta.url,
  ),
);
const metadata = JSON.parse(
  metadataBytes.toString(),
) as GolangModuleVersionMetadata;
const goSumText = await readFile(
  new URL('../../../fixtures/catalogs/golang/go.sum', import.meta.url),
  'utf8',
);
const goModText = await readFile(
  new URL('../../../fixtures/catalogs/golang/go.mod', import.meta.url),
  'utf8',
);
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

const provenance = {
  providerId: 'fixture',
  endpoint: 'https://fixtures.test',
  retrievedAt: '2026-08-02T00:00:00Z',
  evaluationTime: '2026-08-02T00:00:00Z',
  metadataDigest: {
    algorithm: 'sha256' as const,
    value: '6'.repeat(64),
  },
};

describe('Golang codec', () => {
  const codec = new GolangCodec();

  it('uses module path identity and release-tag ordering', () => {
    expect(
      codec.canonicalizePurl(
        'pkg:golang/github.com/openpacker/demo-zstd@v1.2.3',
      ),
    ).toBe('pkg:golang/github.com/openpacker/demo-zstd@v1.2.3');
    expect(
      codec.parseNativeCoordinate('github.com/openpacker/demo-zstd@v1.0.0'),
    ).toMatchObject({
      ecosystem: 'golang',
      namespace: 'github.com/openpacker',
      name: 'demo-zstd',
      version: 'v1.0.0',
    });
    expect(codec.compareNativeVersions('v1.0.0', 'v1.1.0')).toBeLessThan(0);
    expect(codec.compareNativeVersions('v1.0.0-beta.1', 'v1.0.0')).toBeLessThan(
      0,
    );
    expect(codec.satisfies('v1.2.3', 'v1.2.3')).toBe(true);
    expect(codec.satisfies('v1.2.4', 'v1.2.3')).toBe(false);
  });

  it('rejects decoded proxy path traversal and URL delimiters', () => {
    for (const purl of [
      'pkg:golang/example.com/%2E%2E%2Fadmin@v1.0.0',
      'pkg:golang/example.com/demo%3Fquery@v1.0.0',
      'pkg:golang/example.com/demo%23fragment@v1.0.0',
    ])
      expect(() => codec.canonicalizePurl(purl), purl).toThrow(/Go module/u);
  });

  it('orders pseudo-versions with SemanticLoss on approximate membership', () => {
    const pseudo = 'v0.0.0-20260101120000-abcdefabcdef';
    const range = codec.parseNativeRange(pseudo);
    expect(range.semanticLoss.map((loss) => loss.code)).toContain(
      'GOLANG_PSEUDO_VERSION_ORDER_APPROXIMATE',
    );
    expect(
      codec.compareNativeVersions(pseudo, 'v0.0.0-20260101120001-abcdefabcdef'),
    ).toBeLessThan(0);
    expect(codec.compareNativeVersions(pseudo, 'v0.0.1')).toBeLessThan(0);
  });

  it('maps exact OS/arch build tags and refuses silent approximation', () => {
    expect(parseExactBuildConstraint('linux && amd64')).toEqual({
      type: 'allOf',
      predicates: [
        { type: 'equals', path: 'os', value: 'linux' },
        { type: 'equals', path: 'architecture', value: 'amd64' },
      ],
    });
    expect(parseExactBuildConstraint('linux || darwin')).toEqual({
      type: 'in',
      path: 'os',
      values: ['linux', 'darwin'],
    });
    expect(parseExactBuildConstraint('linux && cgo')).toBeUndefined();
    expect(parseExactBuildConstraint('!windows')).toBeUndefined();
  });

  it('maps retracted module metadata to yanked lifecycle', async () => {
    const translated = await codec.translateMetadata(
      { ...metadata, retracted: true },
      provenance,
    );
    expect(translated.instance.lifecycle).toMatchObject({
      status: 'yanked',
      eligible: false,
    });
    expect(
      translated.instance.lifecycle.warnings.map((warning) => warning.code),
    ).toContain('GOLANG_RETRACTED');
  });

  it('translates module metadata with h1 SemanticLoss and exact build predicates', async () => {
    const translated = await codec.translateMetadata(metadata, provenance);
    expect(translated.instance.identity.exactPurl).toBe(
      'pkg:golang/github.com/openpacker/demo-zstd@v1.0.0',
    );
    expect(translated.instance.requirements[0]?.expression).toMatchObject({
      type: 'package',
      purl: 'pkg:golang/github.com/openpacker/cfg-if',
    });
    expect(translated.instance.semanticLoss.map((loss) => loss.code)).toContain(
      'GOLANG_H1_NOT_SHA256',
    );
    expect(translated.instance.nativeSemantics.data).toMatchObject({
      targetPredicate: {
        type: 'allOf',
        predicates: [
          { type: 'equals', path: 'os', value: 'linux' },
          { type: 'equals', path: 'architecture', value: 'amd64' },
        ],
      },
      moduleCodeExecuted: false,
      h1: metadata.h1,
    });
  });

  it('captures go.sum without invoking the go toolchain', () => {
    const parsed = parseGoSum(goSumText);
    expect(parsed.entries.length).toBeGreaterThanOrEqual(4);
    const capture = codec.translateLockResult(goSumText, provenance);
    expect(capture.format).toBe('go.sum');
    const demo = capture.packages.find(
      (entry) =>
        entry.exactPurl === 'pkg:golang/github.com/openpacker/demo-zstd@v1.0.0',
    );
    expect(demo).toMatchObject({
      exactPurl: 'pkg:golang/github.com/openpacker/demo-zstd@v1.0.0',
      artifactDigest: 'h1:/xd4xipvyZMZERnuu3rPXterf1ltnibuQyR/lyUtCEQ=',
    });
    expect(
      capture.packages.some((entry) =>
        entry.nativeCoordinate.includes('cfg-if'),
      ),
    ).toBe(true);
    expect(capture.semanticLoss.map((loss) => loss.code)).toContain(
      'GOLANG_H1_NOT_SHA256',
    );
    expect(capture.semanticLoss.map((loss) => loss.code)).toContain(
      'GOLANG_PSEUDO_VERSION_ORDER_APPROXIMATE',
    );
  });

  it('parses retract directives from go.mod without inventing requires', () => {
    const document = parseGoMod(`module github.com/openpacker/demo-zstd

go 1.22

require github.com/openpacker/cfg-if v1.0.0

retract (
	v1.0.0
	[v1.1.0, v1.1.5]
)
`);
    expect(document.requires).toEqual([
      expect.objectContaining({
        path: 'github.com/openpacker/cfg-if',
        version: 'v1.0.0',
      }),
    ]);
    expect(document.retracts).toEqual(['v1.0.0', '[v1.1.0, v1.1.5]']);
  });

  it('yanks inspect when a retract interval covers the version', async () => {
    const encoder = new TextEncoder();
    const modulePath = 'github.com/openpacker/demo-zstd';
    const encoded = encodeGoModulePath(modulePath);
    const provider = new GolangProxyProvider(
      new FixtureHttpTransport(
        new Map([
          [
            `https://fixtures.test/${encoded}/@v/v1.1.0.info`,
            {
              status: 200,
              headers: {},
              body: encoder.encode(
                '{"Version":"v1.1.0","Time":"2026-02-01T12:00:00Z"}',
              ),
            },
          ],
          [
            `https://fixtures.test/${encoded}/@v/v1.1.0.mod`,
            {
              status: 200,
              headers: {},
              body: encoder.encode(`module github.com/openpacker/demo-zstd

go 1.22

retract [v1.0.0, v1.1.5]
`),
            },
          ],
        ]),
      ),
      { now: () => '2026-08-02T00:00:00Z' },
      'https://fixtures.test',
    );
    const inspection = await provider.inspect(
      'pkg:golang/github.com/openpacker/demo-zstd@v1.1.0',
    );
    expect(inspection.package.lifecycle).toMatchObject({
      status: 'yanked',
      eligible: false,
    });
  });

  it('captures go.mod require blocks as a secondary lock input', () => {
    const document = parseGoMod(goModText);
    expect(document.requires).toHaveLength(2);
    const capture = codec.translateLockResult(
      { format: 'go.mod', data: document },
      provenance,
    );
    expect(capture.format).toBe('go.mod');
    expect(capture.packages.map((entry) => entry.exactPurl).sort()).toEqual([
      'pkg:golang/github.com/openpacker/cfg-if@v1.0.0',
      'pkg:golang/github.com/openpacker/demo-zstd@v1.0.0',
    ]);
    expect(capture.semanticLoss.map((loss) => loss.code)).toContain(
      'GOLANG_GOMOD_IS_SECONDARY_LOCK',
    );
  });
});

it('reads deterministic proxy.golang.org-style fixtures offline', async () => {
  expect(encodeGoModulePath('github.com/OpenPacker/Demo')).toBe(
    'github.com/!open!packer/!demo',
  );
  const modulePath = 'github.com/openpacker/demo-zstd';
  const encoded = encodeGoModulePath(modulePath);
  const provider = new GolangProxyProvider(
    new FixtureHttpTransport(
      new Map([
        [
          `https://fixtures.test/${encoded}/@v/list`,
          [
            {
              status: 200,
              headers: { etag: '"golang-1"' },
              body: listBytes,
            },
            {
              status: 304,
              headers: { etag: '"golang-1"' },
              body: new Uint8Array(),
            },
          ],
        ],
        [
          `https://fixtures.test/${encoded}/@v/v1.0.0.info`,
          { status: 200, headers: { etag: '"golang-1"' }, body: infoBytes },
        ],
        [
          `https://fixtures.test/${encoded}/@v/v1.0.0.mod`,
          { status: 200, headers: {}, body: modBytes },
        ],
        [
          `https://fixtures.test/${encoded}/@v/v1.0.0.zip`,
          { status: 200, headers: {}, body: archive },
        ],
      ]),
    ),
    { now: () => '2026-08-02T00:00:00Z' },
    'https://fixtures.test',
  );

  expect(
    await provider.enumerate('pkg:golang/github.com/openpacker/demo-zstd'),
  ).toEqual([
    'pkg:golang/github.com/openpacker/demo-zstd@v0.0.0-20260101120000-abcdefabcdef',
    'pkg:golang/github.com/openpacker/demo-zstd@v1.0.0-beta.1',
    'pkg:golang/github.com/openpacker/demo-zstd@v1.0.0',
    'pkg:golang/github.com/openpacker/demo-zstd@v1.1.0',
  ]);
  await provider.enumerate('pkg:golang/github.com/openpacker/demo-zstd');

  const inspection = await provider.inspect(
    'pkg:golang/github.com/openpacker/demo-zstd@v1.0.0',
  );
  expect(inspection.package.identity.exactPurl).toBe(
    'pkg:golang/github.com/openpacker/demo-zstd@v1.0.0',
  );
  expect(inspection.package.requirements[0]?.expression).toMatchObject({
    type: 'package',
    purl: 'pkg:golang/github.com/openpacker/cfg-if',
  });
  expect(inspection.package.nativeSemantics.data).toMatchObject({
    moduleCodeExecuted: false,
    path: modulePath,
  });

  const artifact = await provider.fetchArtifactRecord(
    'pkg:golang/github.com/openpacker/demo-zstd@v1.0.0',
  );
  expect(artifact.rawBody).toEqual(archive);
  expect(artifact.body).toMatchObject({
    digest: {
      value: 'b7fb17a4ade3543e21667bdf71fbf51fd73e9166a8fa976c14837866b2353c1c',
    },
    size: 34,
    mediaType: 'application/zip',
  });

  const snapshot = await provider.snapshot('2026-08-02T00:00:00Z');
  expect(snapshot.etag).toBe('"golang-1"');
  expect(snapshot.revision).toMatch(/^sha256:/);
  expect(snapshot.providerId).toBe('golang-proxy');
});

it('warns when the .mod file is missing instead of claiming zero dependencies', async () => {
  const modulePath = 'github.com/openpacker/demo-zstd';
  const encoded = encodeGoModulePath(modulePath);
  const provider = new GolangProxyProvider(
    new FixtureHttpTransport(
      new Map([
        [
          `https://fixtures.test/${encoded}/@v/v1.0.0.info`,
          { status: 200, headers: {}, body: infoBytes },
        ],
        [
          `https://fixtures.test/${encoded}/@v/v1.0.0.mod`,
          { status: 404, headers: {}, body: new Uint8Array() },
        ],
      ]),
    ),
    { now: () => '2026-08-02T00:00:00Z' },
    'https://fixtures.test',
  );
  const inspection = await provider.inspect(
    'pkg:golang/github.com/openpacker/demo-zstd@v1.0.0',
  );
  expect(inspection.package.requirements).toEqual([]);
  expect(inspection.warnings).toEqual([
    expect.objectContaining({ code: 'GOLANG_MOD_NOT_AVAILABLE' }),
  ]);
});

it('fails closed when the .mod fetch is unavailable', async () => {
  const modulePath = 'github.com/openpacker/demo-zstd';
  const encoded = encodeGoModulePath(modulePath);
  const provider = new GolangProxyProvider(
    new FixtureHttpTransport(
      new Map([
        [
          `https://fixtures.test/${encoded}/@v/v1.0.0.info`,
          { status: 200, headers: {}, body: infoBytes },
        ],
        [
          `https://fixtures.test/${encoded}/@v/v1.0.0.mod`,
          { status: 503, headers: {}, body: new Uint8Array() },
        ],
      ]),
    ),
    { now: () => '2026-08-02T00:00:00Z' },
    'https://fixtures.test',
  );
  await expect(
    provider.inspect('pkg:golang/github.com/openpacker/demo-zstd@v1.0.0'),
  ).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
});
