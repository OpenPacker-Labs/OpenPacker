import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 0.3 to 1.7 s alone, over 5 s at a load of 15 or more (npm run verify runs
    // every package's tests at once on 4 CPUs): the default 5 s bound is a load
    // test, not a check of anything these suites assert.
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
