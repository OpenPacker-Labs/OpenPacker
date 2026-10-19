import { resolve } from 'node:path';
import { defineConfig, mergeConfig } from 'vitest/config';
import shared from '../vitest.shared.ts';

// The shared 30 s bound also covers V8 precise coverage, which makes
// filesystem and process tests materially slower.
export default mergeConfig(
  shared,
  defineConfig({
    root: resolve(import.meta.dirname, '..'),
    test: {
      fileParallelism: false,
      setupFiles: [
        resolve(import.meta.dirname, 'adapter-registry-setup.mjs'),
        resolve(import.meta.dirname, 'v8-coverage-setup.mjs'),
        resolve(import.meta.dirname, '../tests/support/store-guard.setup.ts'),
      ],
    },
  }),
);
