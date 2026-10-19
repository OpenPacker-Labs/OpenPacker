import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: resolve(import.meta.dirname, '..'),
  test: {
    fileParallelism: false,
    // V8 precise coverage makes filesystem/process tests materially slower;
    // keep the coverage gate from turning instrumentation overhead into a
    // false timeout while ordinary test runs retain Vitest's tighter default.
    testTimeout: 30_000,
    setupFiles: [
      resolve(import.meta.dirname, 'adapter-registry-setup.mjs'),
      resolve(import.meta.dirname, 'v8-coverage-setup.mjs'),
    ],
  },
});
