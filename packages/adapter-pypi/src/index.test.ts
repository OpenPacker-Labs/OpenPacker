import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { FixtureHttpTransport } from '@openpacker/adapter-core';
import {
  normalizePypiName,
  PypiCodec,
  PypiJsonProvider,
  type PypiProjectDocument,
  type UvLockDocument,
} from './index.js';

const encoder = new TextEncoder();
const projectBytes = await readFile(
  new URL('../../../fixtures/catalogs/pypi/project.json', import.meta.url),
);
const project = JSON.parse(projectBytes.toString()) as PypiProjectDocument;
const uvLockBytes = await readFile(
  new URL('../../../fixtures/catalogs/pypi/uv.lock.json', import.meta.url),
);
const uvLock = JSON.parse(uvLockBytes.toString()) as UvLockDocument;
const wheel = await readFile(
  new URL(
    '../../../fixtures/catalogs/pypi/demo_tool-1.0.0-py3-none-any.whl',
    import.meta.url,
  ),
);
const sdist = await readFile(
  new URL(
    '../../../fixtures/catalogs/pypi/demo_tool-1.0.0.tar.gz',
    import.meta.url,
  ),
);
const mixedYankedBytes = await readFile(
  new URL(
    '../../../fixtures/catalogs/pypi/project-mixed-yanked.json',
    import.meta.url,
  ),
);
const mixedYanked = JSON.parse(
  mixedYankedBytes.toString(),
) as PypiProjectDocument;

describe('pypi codec laws', () => {
  const codec = new PypiCodec();

  it('normalizes PEP 503 / PURL names and is idempotent', () => {
    expect(normalizePypiName('Demo_Tool')).toBe('demo-tool');
    expect(normalizePypiName('zope.interface')).toBe('zope-interface');
    expect(normalizePypiName('friendly_bard')).toBe('friendly-bard');
    expect(codec.canonicalizePurl('pkg:PYPI/Demo_Tool@1.0.0')).toBe(
      'pkg:pypi/demo-tool@1.0.0',
    );
    expect(
      codec.canonicalizePurl(
        codec.canonicalizePurl('pkg:pypi/Demo_Tool@1.0.0'),
      ),
    ).toBe('pkg:pypi/demo-tool@1.0.0');
    const coordinate = codec.parseNativeCoordinate('Demo_Tool@1.0.0');
    expect(coordinate).toMatchObject({
      ecosystem: 'pypi',
      name: 'demo-tool',
      version: '1.0.0',
    });
  });

  it('parses and compares PEP 440 versions', () => {
    expect(codec.parseNativeVersion('1.0.0').normalized).toBe('1.0.0');
    expect(codec.parseNativeVersion('1.0.0b1').normalized).toBe('1.0.0b1');
    expect(codec.parseNativeVersion('1!1.0.0').normalized).toBe('1!1.0.0');
    expect(codec.parseNativeVersion('1.0.0+local.1').normalized).toBe(
      '1.0.0+local.1',
    );
    expect(codec.compareNativeVersions('1.0.0b1', '1.0.0')).toBeLessThan(0);
    expect(codec.compareNativeVersions('1.0.0', '1.0.0.post1')).toBeLessThan(0);
    expect(codec.compareNativeVersions('1.0.0.dev1', '1.0.0')).toBeLessThan(0);
    expect(codec.compareNativeVersions('1.0.0', '1.0.0+local')).toBeLessThan(0);
    expect(codec.compareNativeVersions('1!1.0', '2.0')).toBeGreaterThan(0);
  });

  it('implements PEP 440 specifier membership and records marker loss', () => {
    expect(codec.satisfies('1.2.3', '>=1.0,<2.0')).toBe(true);
    expect(codec.satisfies('2.0.0', '>=1.0,<2.0')).toBe(false);
    expect(codec.satisfies('1.4.5', '~=1.4.5')).toBe(true);
    expect(codec.satisfies('1.5.0', '~=1.4.5')).toBe(false);
    expect(codec.satisfies('1.2.0', '==1.2.*')).toBe(true);
    expect(codec.satisfies('1.3.0', '==1.2.*')).toBe(false);
    expect(codec.satisfies('1.0.0+local', '==1.0.0')).toBe(true);
    expect(codec.satisfies('1.0', '===1.0')).toBe(true);
    expect(codec.satisfies('1.0.0', '===1.0')).toBe(false);

    const withMarker = codec.parseNativeRange(
      'beta[security]>=2.0; python_version >= "3.10"',
    );
    expect(withMarker.semanticLoss.map((loss) => loss.code)).toEqual(
      expect.arrayContaining([
        'PYPI_ENVIRONMENT_MARKER',
        'PYPI_EXTRAS_NOT_CAPABILITIES',
      ]),
    );
    // Markers are never silently treated as false: specifier may still match.
    expect(codec.satisfies('2.1.0', withMarker)).toBe(true);

    const exact = codec.parseNativeRange('==1.2.3');
    expect(exact.vers).toBe('vers:pypi/=1.2.3');
    expect(exact.reversible).toBe(true);
  });

  it('translates metadata with wheel/sdist artifacts and marker losses', async () => {
    const translated = await codec.translateMetadata(
      { kind: 'project-version', project, version: '1.0.0' },
      {
        providerId: 'fixture',
        endpoint: 'https://fixtures.test',
        retrievedAt: '2026-08-02T00:00:00Z',
        evaluationTime: '2026-08-02T00:00:00Z',
        metadataDigest: { algorithm: 'sha256', value: '2'.repeat(64) },
      },
    );
    expect(translated.instance.identity.exactPurl).toBe(
      'pkg:pypi/demo-tool@1.0.0',
    );
    expect(
      translated.instance.artifacts.map((a) => a.nativeRole).sort(),
    ).toEqual(['sdist', 'wheel']);
    expect(
      translated.instance.requirements.some((requirement) =>
        requirement.semanticLoss.some(
          (loss) => loss.code === 'PYPI_ENVIRONMENT_MARKER',
        ),
      ),
    ).toBe(true);
    expect(
      translated.instance.requirements.some((requirement) =>
        requirement.semanticLoss.some(
          (loss) => loss.code === 'PYPI_EXTRAS_NOT_CAPABILITIES',
        ),
      ),
    ).toBe(true);
  });

  it('omits yanked files when a live distribution exists', async () => {
    const translated = await codec.translateMetadata(
      { kind: 'project-version', project: mixedYanked, version: '1.0.0' },
      {
        providerId: 'fixture',
        endpoint: 'https://fixtures.test',
        retrievedAt: '2026-08-02T00:00:00Z',
        evaluationTime: '2026-08-02T00:00:00Z',
        metadataDigest: { algorithm: 'sha256', value: '4'.repeat(64) },
      },
    );
    expect(translated.instance.lifecycle.status).toBe('published');
    expect(translated.instance.lifecycle.eligible).toBe(true);
    expect(
      translated.instance.artifacts.map((artifact) => artifact.fileName),
    ).toEqual(['demo_mixed-1.0.0.tar.gz']);
    expect(translated.instance.nativeSemantics.data).toMatchObject({
      files: [
        {
          filename: 'demo_mixed-1.0.0-py3-none-any.whl',
          yanked: true,
        },
        {
          filename: 'demo_mixed-1.0.0.tar.gz',
          yanked: false,
          sha256:
            '437087440e1c80b5dbea070ab18f4746ad804e8d0740560c932a01ea37ceb0e8',
        },
      ],
    });
  });

  it('marks a version yanked only when every file is yanked', async () => {
    const translated = await codec.translateMetadata(
      { kind: 'project-version', project: mixedYanked, version: '1.1.0' },
      {
        providerId: 'fixture',
        endpoint: 'https://fixtures.test',
        retrievedAt: '2026-08-02T00:00:00Z',
        evaluationTime: '2026-08-02T00:00:00Z',
        metadataDigest: { algorithm: 'sha256', value: '5'.repeat(64) },
      },
    );
    expect(translated.instance.lifecycle.status).toBe('yanked');
    expect(translated.instance.lifecycle.eligible).toBe(false);
    expect(translated.instance.artifacts).toHaveLength(2);
  });

  it('captures uv.lock version 1 JSON without network', () => {
    const capture = codec.translateLockResult(uvLock, {
      providerId: 'fixture',
      endpoint: 'https://fixtures.test',
      retrievedAt: '2026-08-02T00:00:00Z',
      evaluationTime: '2026-08-02T00:00:00Z',
      metadataDigest: { algorithm: 'sha256', value: '3'.repeat(64) },
    });
    expect(capture.format).toBe('uv.lock');
    expect(capture.formatVersion).toBe('1');
    expect(
      capture.packages.find(
        (entry) => entry.exactPurl === 'pkg:pypi/demo-tool@1.0.0',
      ),
    ).toMatchObject({
      exactPurl: 'pkg:pypi/demo-tool@1.0.0',
      artifactDigest:
        'sha256:d93c74da6add765cc6a03769e21752daf17bdd291376b82347e3c71a7e0f5318',
      dependencies: {
        alpha: 'locked',
        beta: 'locked',
      },
    });
    expect(capture.semanticLoss.map((loss) => loss.code)).toEqual(
      expect.arrayContaining([
        'PYPI_LOCK_REQUIRES_PYTHON',
        'PYPI_ENVIRONMENT_MARKER',
        'PYPI_EXTRAS_NOT_CAPABILITIES',
      ]),
    );
  });
});

it('enumerates and inspects deterministic PyPI JSON fixtures offline', async () => {
  const body = encoder.encode(JSON.stringify(project));
  const transport = new FixtureHttpTransport(
    new Map([
      [
        'https://fixtures.test/demo-tool/json',
        [
          { status: 200, headers: { etag: '"pypi-1"' }, body },
          {
            status: 304,
            headers: { etag: '"pypi-1"' },
            body: new Uint8Array(),
          },
        ],
      ],
      [
        'https://fixtures.openpacker.invalid/pypi/demo_tool-1.0.0-py3-none-any.whl',
        { status: 200, headers: {}, body: wheel },
      ],
      [
        'https://fixtures.openpacker.invalid/pypi/demo_tool-1.0.0.tar.gz',
        { status: 200, headers: {}, body: sdist },
      ],
    ]),
  );
  const provider = new PypiJsonProvider(
    transport,
    { now: () => '2026-08-02T00:00:00Z' },
    'https://fixtures.test',
  );

  expect(await provider.enumerate('pkg:pypi/Demo_Tool')).toEqual([
    'pkg:pypi/demo-tool@1.0.0b1',
    'pkg:pypi/demo-tool@1.0.0',
    'pkg:pypi/demo-tool@1.1.0',
  ]);
  await provider.enumerate('pkg:pypi/demo-tool');
  expect(transport.requests[1]?.headers?.['if-none-match']).toBe('"pypi-1"');

  const inspected = await provider.inspect('pkg:pypi/demo-tool@1.0.0');
  expect(inspected.package.identity.exactPurl).toBe('pkg:pypi/demo-tool@1.0.0');
  expect(inspected.package.artifacts).toHaveLength(2);
  expect(
    inspected.package.requirements.some((requirement) =>
      requirement.semanticLoss.some(
        (loss) => loss.code === 'PYPI_ENVIRONMENT_MARKER',
      ),
    ),
  ).toBe(true);

  const yanked = await provider.inspect('pkg:pypi/demo-tool@1.1.0');
  expect(yanked.package.lifecycle.status).toBe('yanked');
  expect(yanked.package.lifecycle.eligible).toBe(false);

  const artifact = await provider.fetchArtifactRecord(
    'pkg:pypi/demo-tool@1.0.0',
  );
  expect(artifact.rawBody).toEqual(wheel);
  expect(artifact.body).toMatchObject({
    digest: {
      algorithm: 'sha256',
      value: 'd93c74da6add765cc6a03769e21752daf17bdd291376b82347e3c71a7e0f5318',
    },
    size: 31,
  });

  const snapshot = await provider.snapshot('2026-08-02T00:00:00Z');
  expect(snapshot.etag).toBe('"pypi-1"');
  expect(snapshot.revision).toMatch(/^sha256:/);
  expect(snapshot.providerId).toBe('pypi-json');

  provider.invalidate('pkg:pypi/demo-tool');
});

it('rejects corrupt wheel bytes', async () => {
  const corrupt = Uint8Array.from(wheel);
  corrupt[0] = corrupt[0]! ^ 1;
  const provider = new PypiJsonProvider(
    new FixtureHttpTransport(
      new Map([
        [
          'https://fixtures.test/demo-tool/json',
          { status: 200, headers: {}, body: projectBytes },
        ],
        [
          'https://fixtures.openpacker.invalid/pypi/demo_tool-1.0.0-py3-none-any.whl',
          { status: 200, headers: {}, body: corrupt },
        ],
      ]),
    ),
    { now: () => '2026-08-02T00:00:00Z' },
    'https://fixtures.test',
  );
  await expect(
    provider.fetchArtifactRecord('pkg:pypi/demo-tool@1.0.0'),
  ).rejects.toMatchObject({ code: 'DIGEST_MISMATCH' });
});
