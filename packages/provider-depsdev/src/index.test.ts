import { expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { FixtureHttpTransport } from '@openpacker/adapter-core';
import { DepsDevProvider } from './index.js';

it('captures deps.dev data as incomplete enrichment, never native authority', async () => {
  const body = await readFile(
    new URL(
      '../../../fixtures/catalogs/depsdev/npm-demo.json',
      import.meta.url,
    ),
  );
  const dependencies = await readFile(
    new URL(
      '../../../fixtures/catalogs/depsdev/npm-demo-dependencies.json',
      import.meta.url,
    ),
  );
  const provider = new DepsDevProvider(
    new FixtureHttpTransport(
      new Map([
        [
          'https://fixtures.test/v3/systems/NPM/packages/%40openpacker%2Fdemo-tool/versions/1.0.0',
          { status: 200, headers: { etag: '"deps-1"' }, body },
        ],
        [
          'https://fixtures.test/v3/systems/NPM/packages/%40openpacker%2Fdemo-tool/versions/1.0.0:dependencies',
          { status: 200, headers: {}, body: dependencies },
        ],
      ]),
    ),
    { now: () => '2026-08-02T00:00:00Z' },
    'https://fixtures.test/v3',
  );
  const result = await provider.enrich(
    'pkg:npm/%40openpacker/demo-tool@1.0.0?registry=fixture',
  );
  expect(result.warnings.map((warning) => warning.code)).toEqual([
    'DEPSDEV_NATIVE_SEMANTICS_INCOMPLETE',
    'DEPSDEV_QUALIFIERS_NOT_APPLIED',
  ]);
  expect(result.semanticLoss[0]?.code).toBe(
    'DEPSDEV_GRAPH_NOT_NATIVE_EQUIVALENT',
  );
  expect(provider.capabilities.targetSpecificSemantics).toBe(false);
  expect(result.extensions['deps.dev/dependencies']).toMatchObject({
    edges: [{ requirement: '^1.0.0' }],
  });
});
