import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Scrub and workspace-real suites hold the worker for tens of seconds. With
    // turbo running the rest of the monorepo in parallel, the default vitest-worker
    // RPC window (~60s) can expire before the runner answers onTaskUpdate.
    fileParallelism: false,
    hookTimeout: 120_000,
  },
});
