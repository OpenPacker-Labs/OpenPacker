import { describe, expect, it } from 'vitest';
import {
  BoundedFetchTransport,
  FixtureHttpTransport,
  MAXIMUM_METADATA_BYTES,
  MINIMUM_BYTES_PER_METADATA_VALUE,
  ResponseTooLargeError,
  json,
  metadataValueLimit,
} from './index.js';

/**
 * The bound on a response is enforced while the body arrives, and says what it
 * saw. A registry can send a Content-Length that is missing, small, or a lie,
 * and none of them may let the client hold more than it asked for.
 */

const origin = 'https://registry.test';

/** What a body was asked for, and whether the reader gave it up. */
interface Reads {
  pulls: number;
  cancelled: boolean;
}

/** A body of `chunks` chunks (forever when undefined), read only on demand. */
function body(chunkBytes: number, chunks?: number) {
  const reads: Reads = { pulls: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        reads.pulls += 1;
        if (chunks !== undefined && reads.pulls > chunks) controller.close();
        else controller.enqueue(new Uint8Array(chunkBytes));
      },
      cancel() {
        reads.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, reads };
}

function transport(
  maximumBytes: number,
  respond: () => Response,
): BoundedFetchTransport {
  return new BoundedFetchTransport({
    allowedOrigins: [origin],
    maximumBytes,
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    fetch: (async () => respond()) as typeof fetch,
  });
}

describe('a response is bounded as it streams', () => {
  it('cuts off a body that never ends and has no Content-Length', async () => {
    const { stream, reads } = body(100);
    const error = await transport(
      1000,
      () => new Response(stream, { status: 200 }),
    )
      .request({ url: `${origin}/endless` })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ResponseTooLargeError);
    expect(error).toMatchObject({
      code: 'UPSTREAM_RESPONSE_TOO_LARGE',
      basis: 'streamed',
      limitBytes: 1000,
      upstreamStatus: 200,
    });
    // It stopped on the chunk that crossed the line, not a chunk later.
    expect((error as ResponseTooLargeError).observedBytes).toBe(1100);
    expect(reads.pulls).toBe(11);
    expect(reads.cancelled).toBe(true);
  });

  it('cuts off a body longer than the Content-Length it announced', async () => {
    const { stream, reads } = body(1000, 50);
    const error = await transport(
      2500,
      () =>
        new Response(stream, {
          status: 200,
          headers: { 'content-length': '10' },
        }),
    )
      .request({ url: `${origin}/liar` })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: 'UPSTREAM_RESPONSE_TOO_LARGE',
      basis: 'streamed',
      observedBytes: 3000,
    });
    expect(reads.pulls).toBe(3);
    expect(reads.cancelled).toBe(true);
  });

  it('refuses a Content-Length over the limit without reading the body', async () => {
    const { stream, reads } = body(100);
    const error = await transport(
      1000,
      () =>
        new Response(stream, {
          status: 200,
          headers: { 'content-length': '100000' },
        }),
    )
      .request({ url: `${origin}/declared` })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: 'UPSTREAM_RESPONSE_TOO_LARGE',
      basis: 'declared',
      limitBytes: 1000,
      observedBytes: 100000,
    });
    expect(reads.pulls).toBe(0);
    expect(reads.cancelled).toBe(true);
  });

  it('accepts a body of exactly the limit and refuses one byte more', async () => {
    const at = await transport(
      300,
      () => new Response(body(100, 3).stream, { status: 200 }),
    ).request({ url: `${origin}/at` });
    expect(at.body.byteLength).toBe(300);
    await expect(
      transport(
        299,
        () => new Response(body(100, 3).stream, { status: 200 }),
      ).request({ url: `${origin}/over` }),
    ).rejects.toMatchObject({ code: 'UPSTREAM_RESPONSE_TOO_LARGE' });
  });
});

describe('a refusal says what was seen and what the limit was', () => {
  const streamed = new ResponseTooLargeError(
    8_388_608,
    8_454_144,
    'streamed',
    200,
  );

  it('states both numbers, in bytes and MiB', () => {
    expect(streamed.message).toBe(
      'Response exceeds the limit of 8388608 bytes (8.00 MiB): ' +
        'stopped reading at 8454144 bytes (8.06 MiB)',
    );
    expect(
      new ResponseTooLargeError(8_388_608, 9_123_456, 'declared').message,
    ).toBe(
      'Response declares 9123456 bytes (8.70 MiB) and exceeds the limit of ' +
        '8388608 bytes (8.00 MiB)',
    );
    expect(
      new ResponseTooLargeError(8_388_608, 9_123_456, 'delivered').message,
    ).toBe(
      'Response is 9123456 bytes (8.70 MiB) and exceeds the limit of ' +
        '8388608 bytes (8.00 MiB)',
    );
  });

  it('can be said about what was being read, keeping its numbers', () => {
    const renamed = streamed.about('The packument of typescript');
    expect(renamed.message).toMatch(
      /^The packument of typescript exceeds the limit of 8388608 bytes/u,
    );
    expect(renamed).toMatchObject({
      code: 'UPSTREAM_RESPONSE_TOO_LARGE',
      limitBytes: 8_388_608,
      observedBytes: 8_454_144,
      basis: 'streamed',
      upstreamStatus: 200,
    });
  });

  it('is what a transport that has the whole body at once throws', async () => {
    const fixtures = new FixtureHttpTransport(
      new Map([
        [
          `${origin}/doc`,
          { status: 200, headers: {}, body: new Uint8Array(40) },
        ],
      ]),
    );
    await expect(
      fixtures.request({ url: `${origin}/doc`, maximumBytes: 39 }),
    ).rejects.toMatchObject({
      code: 'UPSTREAM_RESPONSE_TOO_LARGE',
      basis: 'delivered',
      observedBytes: 40,
      limitBytes: 39,
    });
  });
});

describe('what a parsed metadata document may hold', () => {
  const document = (values: number) => ({
    status: 200,
    headers: {},
    body: new TextEncoder().encode(
      `[${Array.from({ length: values }, () => '[]').join(',')}]`,
    ),
    url: `${origin}/doc`,
  });

  it('keeps 200,000 values for a caller that states no other', () => {
    expect(() => json(document(199_990))).not.toThrow();
    expect(() => json(document(200_001))).toThrow(
      /Provider metadata exceeds 200000 values/u,
    );
  });

  it('takes the limit the caller reads under', () => {
    expect(() =>
      json(document(260_520), { maximumNodes: 300_000 }),
    ).not.toThrow();
    expect(() => json(document(300_001), { maximumNodes: 300_000 })).toThrow(
      expect.objectContaining({ code: 'INVALID_PROVIDER_METADATA' }),
    );
  });

  it('derives the value limit from the byte limit, never a number of its own', () => {
    expect(metadataValueLimit(64 * 1024 * 1024)).toBe(4_194_304);
    expect(metadataValueLimit(96 * 1024 * 1024)).toBe(6_291_456);
    expect(MINIMUM_BYTES_PER_METADATA_VALUE).toBe(16);
  });

  it('sits above the 8 MiB first used and below what an artifact may weigh', () => {
    expect(MAXIMUM_METADATA_BYTES).toBeGreaterThan(8 * 1024 * 1024);
    expect(MAXIMUM_METADATA_BYTES).toBeLessThan(128 * 1024 * 1024);
  });
});
