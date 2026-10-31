import { defineConfig } from 'vitest/config';

// The plugin store defaults to OPM_PLUGIN_HOME or XDG_DATA_HOME: every test file
// gets fresh ones, never the caller's (tests/support/stores.setup.ts).
export default defineConfig({
  test: {
    setupFiles: ['../../tests/support/stores.setup.ts'],
  },
});
