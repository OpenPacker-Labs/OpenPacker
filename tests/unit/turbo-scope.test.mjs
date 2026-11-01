import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyWideImpactExpansion,
  ciTurboScope,
  isWideImpactPath,
  turboFilterArgs,
} from '../../scripts/ci/turbo-scope.mjs';

test('full gate on merge_group, main push, and forced CI full', () => {
  assert.deepEqual(ciTurboScope({ GITHUB_EVENT_NAME: 'merge_group' }), {
    mode: 'full',
    reason: 'merge_group',
  });
  assert.deepEqual(
    ciTurboScope({
      GITHUB_EVENT_NAME: 'push',
      GITHUB_REF: 'refs/heads/main',
    }),
    { mode: 'full', reason: 'push_main' },
  );
  assert.deepEqual(
    ciTurboScope({
      GITHUB_EVENT_NAME: 'pull_request',
      OPENPACKER_CI_FULL: '1',
    }),
    { mode: 'full', reason: 'OPENPACKER_CI_FULL' },
  );
});

test('pull_request uses origin base ref for affected scope', () => {
  const scope = ciTurboScope({
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_BASE_REF: 'feature/parent',
  });
  assert.equal(scope.mode, 'affected');
  assert.equal(scope.comparisonRef, 'origin/feature/parent');
  assert.deepEqual(turboFilterArgs(scope), [
    '--filter=...[origin/feature/parent]',
  ]);
});

test('wide-impact paths are recognised', () => {
  assert.ok(isWideImpactPath('scripts/agent-check.mjs'));
  assert.ok(isWideImpactPath('turbo.json'));
  assert.ok(!isWideImpactPath('packages/opm/src/foo.ts'));
});

test('wide-impact diffs expand affected scope to full', () => {
  const affected = {
    mode: 'affected',
    comparisonRef: 'origin/main',
    reason: 'pull_request',
  };
  const narrow = applyWideImpactExpansion(affected, process.cwd(), () => [
    'packages/opm/src/foo.ts',
  ]);
  assert.equal(narrow.mode, 'affected');
  const wide = applyWideImpactExpansion(affected, process.cwd(), () => [
    'scripts/run-gate.mjs',
  ]);
  assert.deepEqual(wide, { mode: 'full', reason: 'wide_impact_paths' });
});

test('empty diff keeps affected scope', () => {
  const affected = {
    mode: 'affected',
    comparisonRef: 'origin/main',
    reason: 'pull_request',
  };
  const scope = applyWideImpactExpansion(affected, process.cwd(), () => []);
  assert.equal(scope.mode, 'affected');
});
