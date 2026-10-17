import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Validating every Registry Definition fixture against the schema took
    // 6.5 s at a load of 60 during npm run verify, which runs every package's
    // tests at once on 4 CPUs. No test here asserts a duration: the default
    // 5 s bound is a load test, not a check of anything these suites assert.
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
