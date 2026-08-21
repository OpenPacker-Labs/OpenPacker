/**
 * Behavior specifications for host-fetch operator pins. Given/When/Then
 * journeys over public APIs: what an operator is promised (and honestly
 * refused), not how BoundedFetchTransport is organised.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const { BoundedFetchTransport, firstPartyOriginPolicy, redactUrl } =
  await import('@openpacker/adapter-core');
const { parseManifest, OpmError } = await import('@openpacker/opm-project');

const digest = `sha256:${'a'.repeat(64)}`;

test('Given a project plugin pin, when opm.toml is parsed, then extra origins are stored and secrets are not', () => {
  // Given an operator who named a private artifact origin in the project
  const toml = `[plugins.dev.example.acme]
store_digest = "${digest}"
artifact_origins = ["https://artifacts.internal.example"]
artifact_origin_token_envs = ["ACME_ARTIFACTS_TOKEN"]
`;

  // When the manifest is loaded
  const parsed = parseManifest(toml);

  // Then the binding holds origin-form pins and env *names*, never token values.
  assert.deepEqual(parsed.plugins?.['dev.example.acme'], {
    storeDigest: digest,
    artifactOrigins: ['https://artifacts.internal.example'],
    artifactOriginTokenEnvs: ['ACME_ARTIFACTS_TOKEN'],
  });
});

test('Given no operator pin, when a hostname rebinds to a private address, then the GET is refused before fetch', async () => {
  // Given a public plugin endpoint with no OPM_HOST_FETCH_ORIGINS pin
  const origin = 'https://acme.example';
  let fetched = false;
  const transport = new BoundedFetchTransport({
    allowedOrigins: [origin],
    destinationPolicy: 'classify-and-pin',
    lookup: async () => [{ address: '10.0.0.1', family: 4 }],
    fetch: async () => {
      fetched = true;
      return new Response('stolen');
    },
  });

  // When the host would download artifact bytes
  await assert.rejects(
    () => transport.request({ url: `${origin}/artifacts/demo.tar` }),
    (error) => {
      assert.equal(error.code, 'INVALID_PROVIDER_ENDPOINT');
      return true;
    },
  );

  // Then the product fail-closes without touching the network.
  assert.equal(fetched, false);
});

test('Given an internal registry override, when first-party origins are computed, then public CDNs are dropped', () => {
  // Given an operator who pointed PyPI at an internal host
  const policy = firstPartyOriginPolicy({
    endpoint: 'https://pypi.internal.example',
    namedOrOverride: true,
    artifactOrigins: ['https://files.pythonhosted.org', 'https://pypi.org'],
  });

  // Then hardcoded public CDNs are not allowlisted, and the override is pinned.
  assert.deepEqual(policy.allowedOrigins, ['https://pypi.internal.example']);
  assert.deepEqual(policy.pinnedOrigins, ['https://pypi.internal.example']);
});

test('Given a credentialed pin string, when it is refused, then the error does not echo the secret', () => {
  // Given a mistaken pin that carried userinfo
  const secret = 'https://user:secret@pinned.test';

  // When the transport is constructed
  assert.throws(
    () =>
      new BoundedFetchTransport({
        allowedOrigins: ['https://acme.example'],
        destinationPolicy: 'classify-and-pin',
        pinnedOrigins: [secret],
      }),
    (error) => {
      assert.equal(error.code, 'INVALID_PROVIDER_ENDPOINT');
      assert.doesNotMatch(error.message, /user:secret/u);
      return true;
    },
  );

  // And redaction of a plugin URL never includes credentials, query, or hash.
  assert.equal(
    redactUrl(new URL('https://user:secret@pinned.test/path?token=1#h')),
    'https://pinned.test/path',
  );
});

test('Given a plugin location with a query token, when the manifest is honest, then parse of a credentialed origin pin is refused', () => {
  // Given an operator (or plugin author) who tried to put userinfo in artifact_origins
  const toml = `[plugins.dev.example.acme]
store_digest = "${digest}"
artifact_origins = ["https://user:secret@artifacts.internal.example"]
`;

  // When the project is loaded
  assert.throws(
    () => parseManifest(toml),
    (error) => {
      assert.ok(error instanceof OpmError);
      assert.equal(error.code, 'INVALID_MANIFEST');
      assert.doesNotMatch(error.message, /user:secret/u);
      return true;
    },
  );
});
