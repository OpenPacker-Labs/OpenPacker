import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./test/setup.ts'],
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
