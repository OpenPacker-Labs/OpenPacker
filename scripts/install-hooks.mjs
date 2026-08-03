#!/usr/bin/env node
/**
 * Wire core.hooksPath to .githooks (fail-open so npm install never dies).
 * Opt out: OPENPACKER_SKIP_HOOKS=1. Skipped automatically in CI.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function skip(reason) {
  console.log(`install-hooks: skipped (${reason}).`);
  process.exit(0);
}

if (process.env.OPENPACKER_SKIP_HOOKS) skip('OPENPACKER_SKIP_HOOKS is set');
if (process.env.CI) skip('CI environment');
if (!existsSync(join(root, '.git'))) skip('not a git working tree');
if (!existsSync(join(root, '.githooks')))
  skip('.githooks directory is missing');

try {
  const hooks = spawnSync('git', ['config', 'core.hooksPath', '.githooks'], {
    cwd: root,
    stdio: 'inherit',
  });
  if (hooks.status === 0)
    console.log('install-hooks: core.hooksPath -> .githooks');
  else console.log('install-hooks: could not set core.hooksPath; skipping.');

  for (const [key, value] of [
    ['rerere.enabled', 'true'],
    ['remote.pushDefault', 'origin'],
  ]) {
    const set = spawnSync('git', ['config', key, value], {
      cwd: root,
      stdio: 'pipe',
    });
    if (set.status === 0) console.log(`install-hooks: ${key}=${value}`);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : 'git unavailable';
  console.log(`install-hooks: skipped (${message}).`);
}

process.exit(0);
