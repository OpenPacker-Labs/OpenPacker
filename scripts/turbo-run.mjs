#!/usr/bin/env node
/**
 * `turbo run <task> [turbo options]` with at most OPENPACKER_TURBO_CONCURRENCY
 * tasks at once: 1 when it is unset or empty.
 *
 * `npm test`, `check:contracts` and `check:generated` run through here. Each of
 * their tasks is one package's `vitest run`, which starts a worker per CPU but
 * one, so turbo's own default of ten at once put about 30 test threads on a
 * 4-CPU machine, and tests that take half a second alone ran past their
 * timeouts (docs/guides/testing.md). A machine with CPUs to spare names a
 * larger number, or a share of its CPUs the way turbo takes one (`50%`).
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export const CONCURRENCY_VARIABLE = 'OPENPACKER_TURBO_CONCURRENCY';

/** The `--concurrency` turbo gets: the variable's value, or 1. */
export function turboConcurrency(env = process.env) {
  const value = env[CONCURRENCY_VARIABLE];
  if (value === undefined || value === '') return '1';
  if (!/^(?:[1-9]\d{0,3}|(?:100|[1-9]\d?)%)$/u.test(value))
    throw new Error(
      `${CONCURRENCY_VARIABLE} takes a number of tasks from 1 to 9999, or a share of the CPUs from 1% to 100%, not ${JSON.stringify(value)}`,
    );
  return value;
}

/** The arguments `turbo` is started with for `node scripts/turbo-run.mjs <argv>`. */
export function turboArguments(argv, env = process.env) {
  const [task, ...rest] = argv;
  if (task === undefined || task.startsWith('-'))
    throw new Error(
      'usage: node scripts/turbo-run.mjs <task> [turbo run options]',
    );
  if (rest.some((option) => option.startsWith('--concurrency')))
    throw new Error(
      `Set ${CONCURRENCY_VARIABLE} instead of passing --concurrency`,
    );
  return ['run', task, ...rest, `--concurrency=${turboConcurrency(env)}`];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let args;
  try {
    args = turboArguments(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  // turbo's own entry, run by this Node: no shell, and no `.cmd` on Windows.
  const turbo = createRequire(import.meta.url).resolve('turbo');
  const result = spawnSync(process.execPath, [turbo, ...args], {
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
