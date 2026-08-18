import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: resolve(import.meta.dirname, '..'),
  test: {
    fileParallelism: false,
    setupFiles: [
      resolve(import.meta.dirname, 'adapter-registry-setup.mjs'),
      resolve(import.meta.dirname, 'v8-coverage-setup.mjs'),
    ],
  },
});
