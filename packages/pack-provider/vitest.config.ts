import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // manifest.test.ts took 7.1 s at a load of 20 to 42 during npm run verify,
    // which runs every package's tests at once on 4 CPUs, and passes alone. It
    // asserts no duration: the default 5 s bound is a load test, not a check of
    // anything these suites assert.
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
