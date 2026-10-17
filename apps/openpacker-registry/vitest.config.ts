import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The 406 negotiation and the holder attribution and rename tests (signed
    // publishes through Fastify's inject) went over 5 s at a load of 20 to 42
    // during npm run verify, which runs every package's tests at once on 4
    // CPUs, and pass alone. None asserts a duration: the default 5 s bound is a
    // load test, not a check of anything these suites assert.
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
