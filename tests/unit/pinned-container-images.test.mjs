import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertDigestPinned,
  OCI_DISTRIBUTION_REGISTRY,
} from '../support/pinned-container-images.mjs';

test('integration container images are digest-pinned', () => {
  assertDigestPinned(OCI_DISTRIBUTION_REGISTRY);
  assert.match(OCI_DISTRIBUTION_REGISTRY, /registry:2/u);
});
