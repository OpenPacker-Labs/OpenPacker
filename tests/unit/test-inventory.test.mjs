import assert from 'node:assert/strict';
import test from 'node:test';
import {
  authorityInventoryFailures,
  workspaceInventoryFailures,
} from '../../scripts/check-test-inventory.mjs';

test('inventory rejects no-op, empty, skipped-only, and unwired gates', () => {
  assert.deepEqual(
    workspaceInventoryFailures([
      {
        workspace: 'no-op',
        testScript: 'true',
        discoveredTests: 1,
        activeTests: 1,
      },
      {
        workspace: 'empty',
        testScript: 'vitest run',
        discoveredTests: 0,
        activeTests: 0,
      },
      {
        workspace: 'skipped',
        testScript: 'vitest run',
        discoveredTests: 1,
        activeTests: 0,
      },
    ]),
    [
      'no-op: test script is not a runnable Vitest gate',
      'empty: Vitest discovered no tests',
      'skipped: discovered suite is skipped or todo only',
    ],
  );
  assert.deepEqual(
    authorityInventoryFailures(
      [
        {
          type: 'chaos',
          script: 'coverage',
          commandIncludes: 'coverage.mjs',
          paths: ['chaos.test.ts'],
        },
      ],
      { coverage: 'true' },
      () => true,
    ),
    ['chaos: coverage is not bound to coverage.mjs'],
  );
});
