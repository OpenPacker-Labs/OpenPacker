#!/usr/bin/env node
/**
 * Run a turbo task with CI scope (full vs affected since the PR base).
 *
 * Usage: node scripts/ci/run-scoped-turbo.mjs <task> [extra turbo args...]
 *
 * Tasks routed through turbo-run.mjs (concurrency cap): test, check:contracts,
 * check:generated. Others use turbo run directly.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCiTurboScope, turboFilterArgs } from './turbo-scope.mjs';
import { turboArguments } from '../turbo-run.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const turboRunTasks = new Set(['test', 'check:contracts', 'check:generated']);

const [task, ...rest] = process.argv.slice(2);
if (!task || task.startsWith('-')) {
  console.error(
    'usage: node scripts/ci/run-scoped-turbo.mjs <task> [turbo options]',
  );
  process.exit(2);
}

const scope = resolveCiTurboScope();
const filterArgs = turboFilterArgs(scope);
console.error(
  `ci:scoped-turbo task=${task} mode=${scope.mode} reason=${scope.reason}${
    scope.mode === 'affected' ? ` ref=${scope.comparisonRef}` : ''
  }`,
);

if (turboRunTasks.has(task)) {
  const args = turboArguments([task, ...filterArgs, ...rest]);
  const turbo = createRequire(import.meta.url).resolve('turbo');
  const result = spawnSync(process.execPath, [turbo, ...args], {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

const turbo = createRequire(import.meta.url).resolve('turbo');
const args = ['run', task, ...filterArgs, ...rest];
const result = spawnSync(process.execPath, [turbo, ...args], {
  cwd: root,
  stdio: 'inherit',
  env: process.env,
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
