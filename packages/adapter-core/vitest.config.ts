import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The chain-order test (counted, not timed) took 8.1 s and the pnpm
    // selection transcription 6.7 s at a load of 45 during npm test, which runs
    // every package's tests at once on 4 CPUs. Neither asserts a duration: the
    // default 5 s bound is a load test, not a check of anything they assert.
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
