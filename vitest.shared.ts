import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * What every package's config and the root coverage and gate configs share:
 * fresh store, cache and plugin directories for every test file, so no test
 * reads or writes the caller's (`tests/support/stores.setup.ts`).
 *
 * It sets no time bound. A package keeps vitest's 5 s default unless its own
 * config states one, as it did before this file existed (opm-project 15 s, the
 * gate config 15 s, the coverage config 30 s); `tests/unit/repository.test.mjs`
 * holds every config to those. A test that times out under load is fixed in the
 * test, by counting its work or waiting for an event, never by a longer bound.
 */
export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/dist/**'],
    setupFiles: [
      fileURLToPath(new URL('tests/support/stores.setup.ts', import.meta.url)),
    ],
  },
});
