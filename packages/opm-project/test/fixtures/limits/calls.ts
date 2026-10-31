import { DEFAULT_MATERIALIZATION_LIMITS } from '@openpacker/materializer';
import {
  materializeThroughSharedStore,
  publishSharedEntry,
} from '../../../src/shared-store.js';

const archive = {
  digest: 'sha256:0',
  bytes: new Uint8Array(),
  format: 'tar+gzip',
} as const;

// @ts-expect-error limits is required
void materializeThroughSharedStore({ ...archive, projectStorePath: '/p' });
// @ts-expect-error limits is required
void publishSharedEntry({ ...archive, sharedRoot: '/s' });

void materializeThroughSharedStore({
  ...archive,
  projectStorePath: '/p',
  limits: DEFAULT_MATERIALIZATION_LIMITS,
});
void publishSharedEntry({
  ...archive,
  sharedRoot: '/s',
  limits: DEFAULT_MATERIALIZATION_LIMITS,
});
