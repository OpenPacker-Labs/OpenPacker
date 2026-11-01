import { defineConfig, mergeConfig } from 'vitest/config';
import shared from '../../vitest.shared.js';

// opm's process entries turn the user-level store on; a test that would reach
// the caller's fails (tests/support/store-guard.setup.ts). Fresh store, cache
// and plugin directories come from the shared config.
//
// Scrub and workspace-real suites hold the worker for tens of seconds. With
// turbo running the rest of the monorepo in parallel, the default vitest-worker
// RPC window (~60s) can expire before the runner answers onTaskUpdate (#231).
export default mergeConfig(
  shared,
  defineConfig({
    test: {
      setupFiles: ['../../tests/support/store-guard.setup.ts'],
      fileParallelism: false,
      hookTimeout: 120_000,
    },
  }),
);
