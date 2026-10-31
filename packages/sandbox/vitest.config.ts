import { defineConfig, mergeConfig } from 'vitest/config';
import shared from '../../vitest.shared.js';

export default mergeConfig(
  shared,
  defineConfig({
    test: {
      // A temporary directory of the run's own, which it must leave empty.
      globalSetup: ['../../scripts/vitest-tmpdir.mjs'],
    },
  }),
);
