import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');

test('third-party GitHub Actions are pinned by commit SHA', () => {
  const result = spawnSync(
    process.execPath,
    ['scripts/ci/apply-action-pins.mjs', '--check'],
    {
      cwd: root,
      encoding: 'utf8',
    },
  );
  assert.equal(
    result.status,
    0,
    result.stderr || result.stdout || 'apply-action-pins --check failed',
  );
});

test('action pin catalog covers checkout and setup-node', () => {
  const pins = JSON.parse(
    readFileSync(join(root, '.github/action-pins.json'), 'utf8'),
  );
  assert.ok(pins['actions/checkout@v6.0.2']?.sha);
  assert.ok(pins['actions/setup-node@v6.4.0']?.sha);
});
