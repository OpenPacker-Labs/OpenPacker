import { describe, expect, it } from 'vitest';
import {
  BearerTokenAuthentication,
  OciRegistryClient,
  RegistryProtocolError,
  ociDescriptor,
  parseOciPurl,
} from './index.js';

/**
 * A registry names URLs in its answers: the token endpoint of a challenge, the
 * next page of a listing, the place to upload to. Each is read through the guard
 * before the URL parser sees it, so a host no DNS name could be is refused by
 * name, in a few milliseconds, with a message that repeats none of it. The
 * parser takes most of a second on 65,550 characters of it
 * (`@openpacker/canonical`'s `untrusted-url.test.ts` measures that); a tag
 * listing's cursor is capped at 4,096 characters, which the 300-character host
 * of its test fits in.
 */
const HOST = 'ß.é.'.repeat(16384);
const SHORT_HOST = 'ß.é.'.repeat(75);
/** A PURL is capped at 4,096 characters, so its host is too. */
const PURL_HOST = 'ß.é.'.repeat(750);
const FAST_MS = 50;
const REGISTRY = 'https://registry.example';

async function timed(
  run: () => void,
): Promise<{ error: Error | undefined; ms: number }> {
  let error: Error | undefined;
  let ms = Infinity;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const started = performance.now();
    try {
      await run();
    } catch (caught) {
      error ??= caught instanceof Error ? caught : new Error(String(caught));
    }
    ms = Math.min(ms, performance.now() - started);
  }
  return { error, ms };
}

async function expectRefusal(
  run: () => void,
  code: string,
): Promise<RegistryProtocolError> {
  const { error, ms } = await timed(run);
  expect(error).toBeInstanceOf(RegistryProtocolError);
  if (!(error instanceof RegistryProtocolError))
    throw new Error('not a RegistryProtocolError');
  expect(error.code).toBe(code);
  expect(error.message).not.toContain('ß');
  expect(error.message.length).toBeLessThan(200);
  expect(ms).toBeLessThan(FAST_MS);
  return error;
}

describe('a bearer challenge', () => {
  it('whose realm names a host no DNS name could be gets no token request', async () => {
    let requests = 0;
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const fetchImplementation = (async () => {
      requests += 1;
      return new Response(null, {
        status: 401,
        headers: {
          'www-authenticate': `Bearer realm="https://${HOST}/token",service="registry"`,
        },
      });
    }) as typeof fetch;
    const auth = new BearerTokenAuthentication({ fetch: fetchImplementation });
    await expectRefusal(
      () =>
        auth.headers(new URL(`${REGISTRY}/v2/demo/tags/list`), 'scope:demo'),
      'UNAUTHORIZED',
    );
    // Only the probe was sent, each time.
    expect(requests).toBe(3);
  });
});

describe('a registry that names the next page of a listing', () => {
  it('is refused when the page is on a host no DNS name could be', async () => {
    const client = new OciRegistryClient({
      registry: REGISTRY,
      repository: 'demo',
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      fetch: (async () =>
        new Response(JSON.stringify({ tags: ['1.0'] }), {
          status: 200,
          headers: {
            link: `<https://${SHORT_HOST}/v2/demo/tags/list>; rel="next"`,
          },
        })) as typeof fetch,
    });
    await expectRefusal(() => client.listTags(), 'UNSAFE_REDIRECT');
  });

  it('is refused when the referrers continue on such a host', async () => {
    const subject = await ociDescriptor(
      new TextEncoder().encode('subject'),
      'application/octet-stream',
    );
    const client = new OciRegistryClient({
      registry: REGISTRY,
      repository: 'openpacker/demo',
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      fetch: (async () =>
        new Response(
          JSON.stringify({
            schemaVersion: 2,
            mediaType: 'application/vnd.oci.image.index.v1+json',
            manifests: [],
          }),
          {
            status: 200,
            headers: { link: `<https://${HOST}/next>; rel="next"` },
          },
        )) as typeof fetch,
    });
    await expectRefusal(() => client.listReferrers(subject), 'UNSAFE_REDIRECT');
  });
});

describe('a registry that names where to upload', () => {
  const bytes = new TextEncoder().encode('blob');

  function stream(): ReadableStream<Uint8Array> {
    return new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  }

  it('is refused when the upload location is on such a host', async () => {
    const client = new OciRegistryClient({
      registry: REGISTRY,
      repository: 'openpacker/demo',
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      fetch: (async (_input: unknown, init?: RequestInit) =>
        init?.method === 'HEAD'
          ? new Response(null, { status: 404 })
          : new Response(null, {
              status: 202,
              headers: { location: `https://${HOST}/upload` },
            })) as typeof fetch,
    });
    const descriptor = await ociDescriptor(bytes, 'application/octet-stream');
    await expectRefusal(
      () => client.pushBlob(descriptor, stream()),
      'UNSAFE_REDIRECT',
    );
  });

  it('is refused when a chunk moves the upload to such a host', async () => {
    const client = new OciRegistryClient({
      registry: REGISTRY,
      repository: 'openpacker/demo',
      monolithicUploadMaximumBytes: 0,
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      fetch: (async (_input: unknown, init?: RequestInit) =>
        init?.method === 'HEAD'
          ? new Response(null, { status: 404 })
          : init?.method === 'POST'
            ? new Response(null, {
                status: 202,
                headers: { location: '/v2/openpacker/demo/blobs/uploads/1' },
              })
            : new Response(null, {
                status: 202,
                headers: { location: `//${HOST}/upload` },
              })) as typeof fetch,
    });
    const descriptor = await ociDescriptor(bytes, 'application/octet-stream');
    await expectRefusal(
      () => client.pushBlob(descriptor, stream()),
      'UNSAFE_REDIRECT',
    );
  });
});

describe('a PURL that names a registry', () => {
  it('is refused when the repository_url names a host no DNS name could be', async () => {
    const { error, ms } = await timed(() =>
      parseOciPurl(
        `pkg:oci/demo@sha256:${'a'.repeat(64)}?repository_url=${PURL_HOST}/demo`,
      ),
    );
    expect(error?.message).toMatch(/not a valid registry reference/u);
    expect(error?.message.length).toBeLessThan(400);
    expect(ms).toBeLessThan(FAST_MS);
  });
});
