#!/usr/bin/env node
/**
 * CI scope for turbo: full monorepo vs affected-only since a comparison ref.
 *
 * Full gate: merge_group, push to main, wide-impact diffs, OPENPACKER_CI_FULL=1,
 * or non-PR events (local workflow_dispatch).
 *
 * Affected-only: pull_request, comparison ref origin/$GITHUB_BASE_REF (stack base).
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

export const WIDE_IMPACT_PREFIXES = [
  'spec/prex/',
  'scripts/',
  'tests/',
  '.github/',
  'crates/',
  'fixtures/protocol/',
  'packages/contracts/',
  'packages/conformance/',
];

export const WIDE_IMPACT_FILES = new Set([
  'package.json',
  'package-lock.json',
  'turbo.json',
  'tsconfig.base.json',
  'Cargo.toml',
  'Cargo.lock',
  'rustfmt.toml',
]);

/** @typedef {{ mode: 'full', reason: string } | { mode: 'affected', comparisonRef: string, reason: string }} CiTurboScope */

/** @param {NodeJS.ProcessEnv} env */
export function ciTurboScope(env = process.env) {
  const forceFull =
    env.OPENPACKER_CI_FULL === '1' || env.OPENPACKER_CI_FULL === 'true';
  if (forceFull) return { mode: 'full', reason: 'OPENPACKER_CI_FULL' };

  const event = env.GITHUB_EVENT_NAME;
  if (event === 'merge_group') return { mode: 'full', reason: 'merge_group' };
  if (event === 'push' && env.GITHUB_REF === 'refs/heads/main')
    return { mode: 'full', reason: 'push_main' };

  if (event === 'pull_request') {
    const baseRef = env.GITHUB_BASE_REF || 'main';
    return {
      mode: 'affected',
      comparisonRef: `origin/${baseRef}`,
      reason: 'pull_request',
    };
  }

  return { mode: 'full', reason: 'default_full' };
}

/** @param {string} file */
export function isWideImpactPath(file) {
  if (WIDE_IMPACT_FILES.has(file)) return true;
  return WIDE_IMPACT_PREFIXES.some((prefix) => file.startsWith(prefix));
}

/**
 * @param {string} comparisonRef
 * @param {string} [cwd]
 */
export function changedFilesSince(comparisonRef, cwd = root) {
  const result = spawnSync(
    'git',
    ['diff', '--name-only', '--diff-filter=ACMR', `${comparisonRef}...HEAD`],
    { cwd, encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(
      result.stderr?.trim() ||
        `git diff ${comparisonRef}...HEAD failed (fetch the base ref first)`,
    );
  }
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * @param {CiTurboScope} scope
 * @param {string} [cwd]
 * @param {(ref: string, cwd: string) => string[]} [listFiles]
 * @returns {CiTurboScope}
 */
export function applyWideImpactExpansion(
  scope,
  cwd = root,
  listFiles = changedFilesSince,
) {
  if (scope.mode !== 'affected') return scope;
  let files;
  try {
    files = listFiles(scope.comparisonRef, cwd);
  } catch {
    return { mode: 'full', reason: 'wide_impact_git_unavailable' };
  }
  if (files.length === 0) return scope;
  if (files.some(isWideImpactPath))
    return { mode: 'full', reason: 'wide_impact_paths' };
  return scope;
}

/** @param {CiTurboScope} scope */
export function resolveCiTurboScope(env = process.env, cwd = root) {
  return applyWideImpactExpansion(ciTurboScope(env), cwd);
}

/** @param {CiTurboScope} scope */
export function turboFilterArgs(scope) {
  if (scope.mode === 'full') return [];
  return [`--filter=...[${scope.comparisonRef}]`];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const scope = resolveCiTurboScope();
  const filters = turboFilterArgs(scope);
  process.stdout.write(`${JSON.stringify({ scope, filters })}\n`);
}
