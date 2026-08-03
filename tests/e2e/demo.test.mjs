import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');

test(
  'Section 4 production demo passes and writes a deterministic indexed artifact set',
  { timeout: 300_000 },
  () => {
    const result = spawnSync(
      process.execPath,
      [join(root, 'scripts/demo.mjs')],
      { cwd: root, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const index = JSON.parse(
      readFileSync(join(root, '.demo-output/index.json'), 'utf8'),
    );
    assert.equal(index.schemaVersion, 'org.openpacker.demo-index.v1');
    assert.ok(index.files.length >= 8);
    assert.equal(
      new Set(index.files.map((entry) => entry.path)).size,
      index.files.length,
    );
    for (const entry of index.files)
      assert.match(entry.digest, /^sha256:[0-9a-f]{64}$/u);
  },
);
