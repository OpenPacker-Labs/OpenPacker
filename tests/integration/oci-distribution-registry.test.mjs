import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalBytes } from '@openpacker/canonical';
import { streamFromBytes } from '@openpacker/artifact-model';
import { dockerAvailable } from '../support/docker-available.mjs';
import { startOciDistributionRegistry } from '../support/oci-distribution-registry.mjs';

const {
  OciRegistryClient,
  ociDescriptor,
  OCI_MEDIA_TYPES,
  OCI_EMPTY_CONFIG_BYTES,
} = await import('@openpacker/oci');

test(
  'Given a Testcontainers OCI distribution registry, when a blob is pushed and pulled, then bytes match',
  { skip: dockerAvailable() ? false : 'docker unavailable' },
  async (t) => {
    const { registry, stop } = await startOciDistributionRegistry();
    t.after(() => stop());

    const client = new OciRegistryClient({
      registry,
      repository: 'openpacker/integration-smoke',
      monolithicUploadMaximumBytes: 16 * 1024 * 1024,
    });
    const payload = new TextEncoder().encode(
      'openpacker-testcontainers-smoke\n',
    );
    const layer = await ociDescriptor(
      payload,
      'application/vnd.openpacker.test',
    );
    await client.pushBlob(layer, streamFromBytes(payload));
    const pulled = await client.pullBlob(layer);
    assert.equal(
      new TextDecoder().decode(pulled),
      new TextDecoder().decode(payload),
    );

    const config = await ociDescriptor(
      OCI_EMPTY_CONFIG_BYTES,
      OCI_MEDIA_TYPES.emptyConfig,
    );
    await client.pushBlob(config, streamFromBytes(OCI_EMPTY_CONFIG_BYTES));
    const manifest = {
      schemaVersion: 2,
      mediaType: OCI_MEDIA_TYPES.manifest,
      config,
      layers: [layer],
    };
    const manifestBytes = canonicalBytes(manifest);
    const manifestDescriptor = await ociDescriptor(
      manifestBytes,
      OCI_MEDIA_TYPES.manifest,
    );
    await client.pushManifest('smoke', manifestBytes, manifestDescriptor);
    const roundTrip = await client.pullManifest('smoke');
    assert.equal(roundTrip.descriptor.digest, manifestDescriptor.digest);
    assert.deepEqual(roundTrip.bytes, manifestBytes);
  },
);
