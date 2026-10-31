import { defineConfig, mergeConfig } from 'vitest/config';
import shared from '../../vitest.shared.js';

export default mergeConfig(
  shared,
  defineConfig({
    test: {
      // Pact owns ephemeral mock/provider servers; parallel files can retire a
      // server while another interaction is still issuing its request.
      fileParallelism: false,
    },
  }),
);
