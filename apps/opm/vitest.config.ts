import { defineConfig, mergeConfig } from 'vitest/config';
import shared from '../../vitest.shared.js';

// opm's process entries turn the user-level store on; a test that would reach
// the caller's fails (tests/support/store-guard.setup.ts).
export default mergeConfig(
  shared,
  defineConfig({
    test: {
      setupFiles: ['../../tests/support/store-guard.setup.ts'],
    },
  }),
);
