import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Pact owns ephemeral mock/provider servers; parallel files can retire a
    // server while another interaction is still issuing its request.
    fileParallelism: false,
  },
});
