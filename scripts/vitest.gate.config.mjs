import { resolve } from 'node:path';
import { defineConfig, mergeConfig } from 'vitest/config';
import shared from '../vitest.shared.ts';

/** Root-level vitest config for security/integration gates. */
export default mergeConfig(
  shared,
  defineConfig({
    root: resolve(import.meta.dirname, '..'),
    test: {
      fileParallelism: false,
      setupFiles: [
        resolve(import.meta.dirname, 'adapter-registry-setup.mjs'),
        resolve(import.meta.dirname, '../tests/support/store-guard.setup.ts'),
      ],
    },
  }),
);
