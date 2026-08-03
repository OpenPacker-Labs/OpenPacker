import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
