import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./test/setup.ts'],
    // A temporary directory of the run's own, which it must leave empty.
    globalSetup: ['../../scripts/vitest-tmpdir.mjs'],
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
