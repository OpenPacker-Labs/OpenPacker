import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

/** Root-level vitest config for security/integration gates. */
export default defineConfig({
  root: resolve(import.meta.dirname, '..'),
  test: {
    fileParallelism: false,
    setupFiles: [resolve(import.meta.dirname, 'adapter-registry-setup.mjs')],
  },
});
