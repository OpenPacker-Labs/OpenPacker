import { DEFAULT_MATERIALIZATION_LIMITS } from '@openpacker/materializer';
import { materializeThroughSharedStore as materialize } from '../src/shared-store.js';

type Input = Parameters<typeof materialize>[0];

/**
 * `materializeThroughSharedStore` under the materializer's default limits, as
 * most of these tests mean it. The function itself takes `limits` as a required
 * argument (shared-store.limits.test.ts).
 */
export const materializeThroughSharedStore = (input: Omit<Input, 'limits'>) =>
  materialize({ ...input, limits: DEFAULT_MATERIALIZATION_LIMITS });
