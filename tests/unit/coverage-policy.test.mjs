import assert from 'node:assert/strict';
import test from 'node:test';
import { coverageFailures } from '../../scripts/coverage-policy.mjs';

test('coverage fails closed when a function-heavy source file was untouched', () => {
  const [failure] = coverageFailures([
    {
      workspace: 'fixture',
      sourceFiles: 2,
      instrumentedFiles: 1,
      instrumentedFilesPercent: 50,
      functions: 1,
      coveredFunctions: 1,
      functionPercent: 100,
    },
  ]);
  assert.equal(failure?.workspace, 'fixture');
});
