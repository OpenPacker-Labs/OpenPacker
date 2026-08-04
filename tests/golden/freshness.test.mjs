import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');

test('golden protocol corpus contains the mandatory artifact classes', () => {
  const manifest = JSON.parse(
    readFileSync(join(root, 'fixtures/golden/manifest.json'), 'utf8'),
  );
  assert.equal(manifest.schemaVersion, 'org.openpacker.golden-manifest.v1');
  const required = [
    'normalize',
    'identity',
    'enumeration',
    'snapshot',
    'universe',
    'solution',
    'proof',
    'explanation',
    'unsatisfiable',
    'receipt',
    'lockfile',
    'lifecycle',
    'event',
    'oci',
    'ocm',
    'tuf',
    'sigstore',
    'slsa',
    'cyclonedx',
  ];
  assert.equal(
    manifest.entries.length,
    required.length,
    'golden manifest must contain exactly one entry per mandatory class',
  );
  assert.deepEqual(
    [...new Set(manifest.entries.map(({ kind }) => kind))].sort(),
    [...required].sort(),
  );
  for (const entry of manifest.entries) {
    const bytes = readFileSync(join(root, entry.file));
    assert.equal(
      `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      entry.digest,
      `${entry.kind} golden is stale`,
    );
  }
});

test('native artifact fixtures exactly match their deterministic generator', () => {
  const result = spawnSync(
    process.execPath,
    [join(root, 'fixtures/artifacts/generate.mjs'), '--check'],
    { cwd: root, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('every golden node identity is the package-node-v1 projection', async () => {
  // Node identity is normative, not a convenient hash of whatever was handy.
  // Six codecs, the nix codec, and the demo each derived it differently once;
  // this pins them to the projection so they cannot drift apart again.
  const { canonicalProjectionDigest, formatDigest } = await import(
    '@openpacker/canonical'
  );
  const { DIGEST_PROJECTIONS } = await import('@openpacker/contracts');
  const projection = DIGEST_PROJECTIONS.projections.find(
    (item) => item.id === 'package-node-v1',
  );
  assert.ok(projection, 'package-node-v1 must exist in the registry');

  const universe = JSON.parse(
    await readFile(join(root, 'fixtures/golden/universe.json'), 'utf8'),
  );
  assert.ok(universe.packages.length > 0, 'universe must contain packages');
  for (const instance of universe.packages) {
    const expected = formatDigest(
      await canonicalProjectionDigest(instance, projection),
    );
    assert.equal(
      instance.nodeId,
      expected,
      `${instance.identity.exactPurl} nodeId is not its package-node-v1 digest`,
    );
  }
});
