import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./test/setup.ts'],
    // The WASM solve through Fastify and the killed-publish chaos test took
    // 6.3 to 6.8 s at a load of 20 to 42 during npm run verify, which runs
    // every package's tests at once on 4 CPUs, and pass alone. Neither asserts
    // a duration: the default 5 s bound is a load test, not a check of
    // anything these suites assert.
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
