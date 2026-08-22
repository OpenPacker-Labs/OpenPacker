import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { FixtureHttpTransport } from '@openpacker/adapter-core';
import { PypiJsonProvider } from './index.js';

const projectBytes = await readFile(
  new URL('../../../fixtures/catalogs/pypi/project.json', import.meta.url),
);
const mixedYankedBytes = await readFile(
  new URL(
    '../../../fixtures/catalogs/pypi/project-mixed-yanked.json',
    import.meta.url,
  ),
);
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

const WHEEL_SHA256 =
  'd93c74da6add765cc6a03769e21752daf17bdd291376b82347e3c71a7e0f5318';
const SDIST_SHA256 =
  '437087440e1c80b5dbea070ab18f4746ad804e8d0740560c932a01ea37ceb0e8';
const WHEEL_URL =
  'https://fixtures.openpacker.invalid/pypi/demo_tool-1.0.0-py3-none-any.whl';
const SDIST_URL =
  'https://fixtures.openpacker.invalid/pypi/demo_tool-1.0.0.tar.gz';
const PROJECT_URL = 'https://fixtures.test/demo-tool/json';

function warehouseProvider() {
  const transport = new FixtureHttpTransport(
    new Map([
      [
        PROJECT_URL,
        {
          status: 200,
          headers: { etag: '"pypi-e2e"' },
          body: projectBytes,
        },
      ],
      [WHEEL_URL, { status: 200, headers: {}, body: wheel }],
      [SDIST_URL, { status: 200, headers: {}, body: sdist }],
    ]),
  );
  return {
    transport,
    provider: new PypiJsonProvider(
      transport,
      { now: () => '2026-08-02T00:00:00Z' },
      'https://fixtures.test',
    ),
  };
}

function assertOfflineWarehouseOnly(transport: FixtureHttpTransport): void {
  expect(transport.requests.length).toBeGreaterThan(0);
  for (const request of transport.requests) {
    expect(request.url).not.toMatch(/pypi\.org/i);
    expect(request.url).not.toMatch(/pythonhosted\.org/i);
    expect(request.url).not.toMatch(/^https?:\/\/pypi\./i);
  }
}

describe('PyPI Warehouse JSON provider e2e (offline)', () => {
  it('enumerates versions from the project document in PEP 440 order', async () => {
    const { provider, transport } = warehouseProvider();
    await expect(provider.enumerate('pkg:pypi/Demo_Tool')).resolves.toEqual([
      'pkg:pypi/demo-tool@1.0.0b1',
      'pkg:pypi/demo-tool@1.0.0',
      'pkg:pypi/demo-tool@1.1.0',
    ]);
    expect(transport.requests[0]?.url).toBe(PROJECT_URL);
    assertOfflineWarehouseOnly(transport);
  });

  it('inspects an exact PURL for identity, requires_dist, artifact URL, and sha256', async () => {
    const { provider, transport } = warehouseProvider();
    const inspected = await provider.inspect('pkg:pypi/demo-tool@1.0.0');
    expect(inspected.package.identity).toMatchObject({
      purlType: 'pypi',
      name: 'demo-tool',
      version: '1.0.0',
      exactPurl: 'pkg:pypi/demo-tool@1.0.0',
    });
    expect(
      inspected.package.requirements.map((requirement) => ({
        purl:
          requirement.expression.type === 'package'
            ? requirement.expression.purl
            : undefined,
        raw: requirement.raw,
      })),
    ).toEqual([
      { purl: 'pkg:pypi/alpha', raw: 'alpha>=1.0' },
      {
        purl: 'pkg:pypi/beta',
        raw: 'beta[security]>=2.0; python_version >= "3.10"',
      },
      { purl: 'pkg:pypi/gamma', raw: 'gamma~=1.2.3' },
    ]);
    expect(
      inspected.package.artifacts.map((artifact) => ({
        fileName: artifact.fileName,
        sha256: artifact.digest.value,
        uri: artifact.locations[0]?.uri,
      })),
    ).toEqual([
      {
        fileName: 'demo_tool-1.0.0-py3-none-any.whl',
        sha256: WHEEL_SHA256,
        uri: WHEEL_URL,
      },
      {
        fileName: 'demo_tool-1.0.0.tar.gz',
        sha256: SDIST_SHA256,
        uri: SDIST_URL,
      },
    ]);
    assertOfflineWarehouseOnly(transport);
  });

  it('marks a yanked release ineligible', async () => {
    const { provider, transport } = warehouseProvider();
    const yanked = await provider.inspect('pkg:pypi/demo-tool@1.1.0');
    expect(yanked.package.lifecycle.status).toBe('yanked');
    expect(yanked.package.lifecycle.eligible).toBe(false);
    expect(
      yanked.package.lifecycle.warnings.map((warning) => warning.code),
    ).toContain('PYPI_YANKED');
    expect(yanked.package.artifacts).toHaveLength(1);
    assertOfflineWarehouseOnly(transport);
  });

  it('preserves requires_python as native semantics and loss, not dropped', async () => {
    const { provider, transport } = warehouseProvider();
    const inspected = await provider.inspect('pkg:pypi/demo-tool@1.0.0');
    expect(inspected.package.nativeSemantics.data).toMatchObject({
      requiresPython: '>=3.9',
      requiresDist: [
        'alpha>=1.0',
        'beta[security]>=2.0; python_version >= "3.10"',
        'gamma~=1.2.3',
      ],
    });
    expect(inspected.package.semanticLoss.map((loss) => loss.code)).toContain(
      'PYPI_REQUIRES_PYTHON_NATIVE',
    );
    assertOfflineWarehouseOnly(transport);
  });

  it('throws VERSION_NOT_FOUND when the project document omits the version', async () => {
    const { provider, transport } = warehouseProvider();
    await expect(
      provider.inspect('pkg:pypi/demo-tool@9.9.9'),
    ).rejects.toMatchObject({ code: 'VERSION_NOT_FOUND' });
    await expect(provider.inspect('pkg:pypi/demo-tool')).rejects.toMatchObject({
      code: 'VERSION_NOT_FOUND',
    });
    assertOfflineWarehouseOnly(transport);
  });

  it('hashes fetched artifact bytes against Warehouse sha256', async () => {
    const { provider, transport } = warehouseProvider();
    const artifact = await provider.fetchArtifactRecord(
      'pkg:pypi/demo-tool@1.0.0',
    );
    expect(artifact.rawBody).toEqual(wheel);
    expect(artifact.body).toMatchObject({
      digest: { algorithm: 'sha256', value: WHEEL_SHA256 },
      size: 31,
      fileName: 'demo_tool-1.0.0-py3-none-any.whl',
      locations: [{ uri: WHEEL_URL }],
    });
    expect(transport.requests.map((request) => request.url)).toEqual([
      PROJECT_URL,
      WHEEL_URL,
    ]);
    assertOfflineWarehouseOnly(transport);
  });

  it('does not pick a yanked wheel when a live artifact exists', async () => {
    const yankedWheelUrl =
      'https://fixtures.openpacker.invalid/pypi/demo_mixed-1.0.0-yanked-py3-none-any.whl';
    const transport = new FixtureHttpTransport(
      new Map([
        [
          'https://fixtures.test/demo-mixed/json',
          { status: 200, headers: {}, body: mixedYankedBytes },
        ],
        [SDIST_URL, { status: 200, headers: {}, body: sdist }],
      ]),
    );
    const provider = new PypiJsonProvider(
      transport,
      { now: () => '2026-08-02T00:00:00Z' },
      'https://fixtures.test',
    );
    const inspected = await provider.inspect('pkg:pypi/Demo_Mixed@1.0.0');
    expect(inspected.package.lifecycle.status).toBe('published');
    expect(inspected.package.lifecycle.eligible).toBe(true);
    expect(
      inspected.package.artifacts.map((artifact) => artifact.fileName),
    ).toEqual(['demo_mixed-1.0.0.tar.gz']);
    expect(inspected.package.artifacts[0]).toMatchObject({
      digest: { algorithm: 'sha256', value: SDIST_SHA256 },
      locations: [{ uri: SDIST_URL }],
    });
    const artifact = await provider.fetchArtifactRecord(
      'pkg:pypi/demo-mixed@1.0.0',
    );
    expect(artifact.rawBody).toEqual(sdist);
    const urls = transport.requests.map((request) => request.url);
    expect(urls).toContain('https://fixtures.test/demo-mixed/json');
    expect(urls).toContain(SDIST_URL);
    expect(urls).not.toContain(yankedWheelUrl);
    assertOfflineWarehouseOnly(transport);
  });

  it('marks the version yanked when every file is yanked', async () => {
    const transport = new FixtureHttpTransport(
      new Map([
        [
          'https://fixtures.test/demo-mixed/json',
          { status: 200, headers: {}, body: mixedYankedBytes },
        ],
      ]),
    );
    const provider = new PypiJsonProvider(
      transport,
      { now: () => '2026-08-02T00:00:00Z' },
      'https://fixtures.test',
    );
    const yanked = await provider.inspect('pkg:pypi/demo-mixed@1.1.0');
    expect(yanked.package.lifecycle.status).toBe('yanked');
    expect(yanked.package.lifecycle.eligible).toBe(false);
    expect(
      yanked.package.artifacts.map((artifact) => artifact.fileName),
    ).toEqual(['demo_mixed-1.1.0-py3-none-any.whl', 'demo_mixed-1.1.0.tar.gz']);
    assertOfflineWarehouseOnly(transport);
  });
});
