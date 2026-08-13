import assert from 'node:assert/strict';
import test from 'node:test';
import { rustMetadataToCycloneDx } from '../../scripts/generate-rust-sbom.mjs';

test('Rust release SBOM is deterministic and preserves dependency edges', () => {
  const metadata = {
    packages: [
      { id: 'b 1.0.0', name: 'b', version: '1.0.0', license: 'MIT' },
      {
        id: 'a 1.0.0',
        name: 'a',
        version: '1.0.0',
        source: 'registry+x',
        checksum: 'ab'.repeat(32),
      },
    ],
    resolve: {
      nodes: [
        { id: 'a 1.0.0', dependencies: ['b 1.0.0'] },
        { id: 'b 1.0.0', dependencies: [] },
      ],
    },
  };
  const first = rustMetadataToCycloneDx(metadata);
  assert.deepEqual(rustMetadataToCycloneDx(metadata), first);
  assert.match(first.serialNumber, /^urn:uuid:[0-9a-f-]{36}$/u);
  assert.deepEqual(first.dependencies[0], {
    ref: 'pkg:cargo/a@1.0.0',
    dependsOn: ['pkg:cargo/b@1.0.0'],
  });
  assert.deepEqual(first.components[0].hashes, [
    { alg: 'SHA-256', content: 'ab'.repeat(32) },
  ]);
});
