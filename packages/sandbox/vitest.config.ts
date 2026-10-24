import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // A temporary directory of the run's own, which it must leave empty.
    globalSetup: ['../../scripts/vitest-tmpdir.mjs'],
  },
});
