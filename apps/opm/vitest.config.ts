import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./test/setup.ts'],
    // The process entry's exit-code test took 4.4 s alone at a load of 44 and
    // went past 5 s in the full suite. It asserts exit codes and output, not a
    // duration: the default 5 s bound is a load test, not a check of anything
    // these suites assert.
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
