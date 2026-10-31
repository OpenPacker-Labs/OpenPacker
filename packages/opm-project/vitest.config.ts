import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Every test file gets fresh store, cache and plugin directories, and a
    // test whose environment would reach the caller's fails
    // (tests/support/stores.setup.ts, tests/support/store-guard.setup.ts).
    setupFiles: [
      './test/setup.ts',
      '../../tests/support/stores.setup.ts',
      '../../tests/support/store-guard.setup.ts',
    ],
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
