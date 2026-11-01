/**
 * Start a digest-pinned OCI distribution registry (registry:2) for integration tests.
 */
import { GenericContainer, Wait } from 'testcontainers';
import { OCI_DISTRIBUTION_REGISTRY } from '../support/pinned-container-images.mjs';

/**
 * @returns {Promise<{ registry: URL, stop: () => Promise<void> }>}
 */
export async function startOciDistributionRegistry() {
  const container = await new GenericContainer(OCI_DISTRIBUTION_REGISTRY)
    .withExposedPorts(5000)
    .withWaitStrategy(Wait.forHttp('/v2/', 5000))
    .start();
  const host = container.getHost();
  const port = container.getMappedPort(5000);
  const registry = new URL(`http://${host}:${port}`);
  return {
    registry,
    stop: () => container.stop(),
  };
}
