import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: resolve(import.meta.dirname, '..'),
  test: {
    setupFiles: [resolve(import.meta.dirname, 'v8-coverage-setup.mjs')],
  },
});
