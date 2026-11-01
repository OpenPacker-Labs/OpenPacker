/**
 * Digest-pinned container images for integration and live-compat tests.
 * Re-resolve digests when intentionally upgrading images.
 */
export const OCI_DISTRIBUTION_REGISTRY =
  'docker.io/library/registry:2.8.3@sha256:46faa9a1ae6813194b53921a370f2f4f8c5e1aae228a89bceafef5847a6a3278';

/** @param {string} image */
export function assertDigestPinned(image) {
  if (!/^[-./:@a-zA-Z0-9_]+@sha256:[a-f0-9]{64}$/u.test(image))
    throw new Error('container image must be pinned by sha256 digest');
}

assertDigestPinned(OCI_DISTRIBUTION_REGISTRY);
