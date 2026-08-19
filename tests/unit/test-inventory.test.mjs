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
        workspace: 'echo',
        testScript: 'echo vitest run',
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
      'echo: test script is not a runnable Vitest gate',
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
          command: 'node scripts/coverage.mjs',
          oracles: ['chaos.test.ts'],
          vitest: ['chaos.test.ts'],
        },
        {
          type: 'live-nix',
          owner: 'packages/adapter-nix',
          script: 'test:live',
          command:
            'OPENPACKER_LIVE_NIX=1 vitest run test/provider.live.test.ts',
          oracles: ['provider.live.test.ts'],
        },
      ],
      new Map([
        ['root', { coverage: 'echo coverage.mjs' }],
        ['packages/adapter-nix', {}],
      ]),
      () => true,
      () => false,
    ),
    [
      'chaos: root coverage does not match its authority command',
      'chaos: no runnable Vitest oracle chaos.test.ts',
      'live-nix: missing packages/adapter-nix test:live script',
    ],
  );
});
