/**
 * Start a digest-pinned Zot registry with Testcontainers and run npm test:live.
 *
 * Required env: OPENPACKER_ZOT_IMAGE (ghcr.io/...@sha256:...), plus the other
 * OPENPACKER_LIVE_* variables used by packages/oci/scripts/live-interop.mjs.
 */
import { spawnSync } from 'node:child_process';
import { GenericContainer, Wait } from 'testcontainers';
import { assertDigestPinned } from '../../tests/support/pinned-container-images.mjs';

const zotImage = process.env.OPENPACKER_ZOT_IMAGE;
if (!zotImage) throw new Error('OPENPACKER_ZOT_IMAGE is required');
assertDigestPinned(zotImage);

const container = await new GenericContainer(zotImage)
  .withExposedPorts(5000)
  .withWaitStrategy(Wait.forHttp('/v2/', 5000))
  .start();

try {
  const host = container.getHost();
  const port = container.getMappedPort(5000);
  const env = {
    ...process.env,
    OPENPACKER_LIVE_TESTS: '1',
    OPENPACKER_LIVE_REGISTRY: `http://${host}:${port}`,
  };
  const result = spawnSync('npm', ['run', 'test:live'], {
    stdio: 'inherit',
    env,
  });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
} finally {
  await container.stop();
}
