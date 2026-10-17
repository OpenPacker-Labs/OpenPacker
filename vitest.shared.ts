import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * The one vitest default every package's config extends, and the root
 * coverage and gate configs too.
 *
 * `npm run verify` runs every package's tests at once on whatever the machine
 * has. Vitest's 5 s default then measured the load as much as the code: tests
 * that pass alone in under a second went past it at loads of 40 to 60. A test
 * that asserts a duration says so itself, as an operation count or a relative
 * bound; this bound only has to outlast the load.
 *
 * Every test file also gets fresh store, cache and plugin directories, so no
 * test reads or writes the caller's (`tests/support/stores.setup.ts`).
 */
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    setupFiles: [
      fileURLToPath(new URL('tests/support/stores.setup.ts', import.meta.url)),
    ],
  },
});
