import { defineConfig, mergeConfig } from 'vitest/config';
import shared from '../../vitest.shared.js';

// The library resolves the shared store, tool cache and plugin store; a test
// that would reach the caller's fails (tests/support/store-guard.setup.ts).
export default mergeConfig(
  shared,
  defineConfig({
    test: {
      setupFiles: [
        './test/setup.ts',
        '../../tests/support/store-guard.setup.ts',
      ],
      // A temporary directory of the run's own, which it must leave empty.
      globalSetup: ['../../scripts/vitest-tmpdir.mjs'],
      testTimeout: 15_000,
      hookTimeout: 15_000,
    },
  }),
);
