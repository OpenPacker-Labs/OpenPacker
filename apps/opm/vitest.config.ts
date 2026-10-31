import { defineConfig } from 'vitest/config';

// opm's process entries turn the user-level store on, and its plugin commands
// use the user-level plugin store: every test file gets fresh ones, and a test
// that would reach the caller's fails (tests/support/stores.setup.ts,
// tests/support/store-guard.setup.ts).
export default defineConfig({
  test: {
    setupFiles: [
      '../../tests/support/stores.setup.ts',
      '../../tests/support/store-guard.setup.ts',
    ],
  },
});
