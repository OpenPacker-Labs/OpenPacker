import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

/** Root-level vitest config for security/integration gates. */
export default defineConfig({
  root: resolve(import.meta.dirname, '..'),
  test: {
    fileParallelism: false,
    testTimeout: 15_000,
    hookTimeout: 15_000,
    setupFiles: [
      resolve(import.meta.dirname, 'adapter-registry-setup.mjs'),
      // Fresh store, cache and plugin directories for every test file, and a
      // test whose environment would reach the caller's fails.
      resolve(import.meta.dirname, '../tests/support/stores.setup.ts'),
      resolve(import.meta.dirname, '../tests/support/store-guard.setup.ts'),
    ],
  },
});
