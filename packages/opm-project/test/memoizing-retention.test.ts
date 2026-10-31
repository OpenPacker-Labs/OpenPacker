import { describe, expect, it } from 'vitest';
import {
  ProviderError,
  type HttpRequest,
  type HttpResponse,
  type HttpTransport,
} from '@openpacker/adapter-core';
import { MemoizingTransport } from '../src/index.js';
import { retainedMetadataBytes } from '../src/retention-config.js';

/**
 * A resolve keeps every registry document it reads, so the bound on one
 * document is not a bound on a resolve. The memo now keeps at most a budget of
 * them, letting go of the least recently used, and fetches again what it let
 * go through the same transport. It lets go only of a transport that says it
 * can be asked again.
 */

const MiB = 1024 * 1024;

/** A registry of documents of given sizes that counts what it was asked. */
class CountingRegistry implements HttpTransport {
  readonly calls: string[] = [];
  constructor(
    readonly refetchable: boolean | undefined,
    private readonly sizes: Record<string, number>,
    private readonly revision: () => number = () => 0,
  ) {}
  async request(request: HttpRequest): Promise<HttpResponse> {
    this.calls.push(request.url);
    const size = this.sizes[request.url.split('/').at(-1)!] ?? 10;
    const body = new Uint8Array(size).fill(65 + this.revision());
    return {
      status: 200,
      headers: { etag: `"${request.url}"` },
      body,
      url: request.url,
    };
  }
}

const get = (name: string, headers: Record<string, string> = {}) => ({
  url: `https://r.test/${name}`,
  headers: { accept: 'application/json', ...headers },
  maximumBytes: 8 * MiB,
});

describe('a memo with a budget', () => {
  it('keeps what fits, and answers it again without asking', async () => {
    const registry = new CountingRegistry(true, { a: 100, b: 100 });
    const memo = new MemoizingTransport(registry, {
      maximumRetainedBytes: 1000,
    });
    await memo.request(get('a'));
    await memo.request(get('b'));
    await memo.request(get('a'));
    await memo.request(get('b'));
    expect(registry.calls).toEqual(['https://r.test/a', 'https://r.test/b']);
    expect(memo.retention.retainedBytes).toBe(200);
    expect(memo.retention.evictions).toBe(0);
  });

  it('lets go of the least recently used and asks for it again when it is needed', async () => {
    const registry = new CountingRegistry(true, { a: 400, b: 400, c: 400 });
    const memo = new MemoizingTransport(registry, {
      maximumRetainedBytes: 1000,
    });
    await memo.request(get('a'));
    await memo.request(get('b'));
    await memo.request(get('a')); // a is used again, so b is the oldest
    await memo.request(get('c')); // 1200 > 1000: b goes
    expect(memo.retention.retainedBytes).toBe(800);
    expect(memo.retention.evictions).toBe(1);
    await memo.request(get('a'));
    await memo.request(get('c'));
    expect(registry.calls).toEqual([
      'https://r.test/a',
      'https://r.test/b',
      'https://r.test/c',
    ]);
    const again = await memo.request(get('b'));
    expect(again.status).toBe(200);
    expect(again.body.byteLength).toBe(400);
    expect(registry.calls.at(-1)).toBe('https://r.test/b');
  });

  it('keeps nothing with a budget of zero, and answers every read from the transport', async () => {
    const registry = new CountingRegistry(true, { a: 100 });
    const memo = new MemoizingTransport(registry, { maximumRetainedBytes: 0 });
    for (let read = 0; read < 4; read += 1) {
      const response = await memo.request(get('a'));
      expect(response.body.byteLength).toBe(100);
      expect(memo.retention.retainedBytes).toBe(0);
    }
    expect(registry.calls).toHaveLength(4);
  });

  it('never holds more than the budget after a read, and never more than a document over it while one is arriving', async () => {
    const sizes: Record<string, number> = {};
    for (let index = 0; index < 40; index += 1)
      sizes[`p${index}`] = 50 + ((index * 37) % 300);
    const registry = new CountingRegistry(true, sizes);
    const budget = 1000;
    const memo = new MemoizingTransport(registry, {
      maximumRetainedBytes: budget,
    });
    const largest = Math.max(...Object.values(sizes));
    for (let pass = 0; pass < 3; pass += 1)
      for (const name of Object.keys(sizes)) {
        await memo.request(get(name));
        expect(memo.retention.retainedBytes).toBeLessThanOrEqual(budget);
      }
    expect(memo.retention.peakBytes).toBeLessThanOrEqual(budget + largest);
    expect(memo.retention.evictions).toBeGreaterThan(0);
  });

  it('answers a revalidation of what it let go by asking, and passes a 304 on', async () => {
    const inner: HttpTransport & { calls: HttpRequest[] } = {
      calls: [],
      refetchable: true,
      async request(request) {
        this.calls.push(request);
        const validator = request.headers?.['if-none-match'];
        return validator === '"v1"'
          ? {
              status: 304,
              headers: { etag: '"v1"' },
              body: new Uint8Array(),
              url: request.url,
            }
          : {
              status: 200,
              headers: { etag: '"v1"' },
              body: new Uint8Array(300),
              url: request.url,
            };
      },
    };
    const memo = new MemoizingTransport(inner, { maximumRetainedBytes: 0 });
    await memo.request(get('a'));
    const revalidated = await memo.request(
      get('a', { 'if-none-match': '"v1"' }),
    );
    expect(revalidated.status).toBe(304);
    expect(inner.calls).toHaveLength(2);
  });

  it('stops when a document it let go comes back different', async () => {
    let revision = 0;
    const registry = new CountingRegistry(
      true,
      { a: 100, b: 100 },
      () => revision,
    );
    const memo = new MemoizingTransport(registry, {
      maximumRetainedBytes: 150,
    });
    await memo.request(get('a'));
    await memo.request(get('b')); // a is let go
    revision = 1;
    const error = await memo
      .request(get('a'))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({
      code: 'STALE_METADATA',
      message:
        'The registry changed https://r.test/a during the resolve; run it again',
    });
  });

  it('says which document changed without what its address carries beside it', async () => {
    let revision = 0;
    const registry = new CountingRegistry(true, {}, () => revision);
    const memo = new MemoizingTransport(registry, { maximumRetainedBytes: 0 });
    const url =
      'https://reader:hunter2@r.test/a?token=vtok_dummy_marker_0123456789abcdef';
    await memo.request({ ...get('a'), url });
    revision = 1;
    const error = await memo
      .request({ ...get('a'), url })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: 'STALE_METADATA',
      message:
        'The registry changed https://r.test/a during the resolve; run it again',
    });
  });

  it('takes the same document again as the same document', async () => {
    const registry = new CountingRegistry(true, { a: 100, b: 100 });
    const memo = new MemoizingTransport(registry, {
      maximumRetainedBytes: 150,
    });
    await memo.request(get('a'));
    await memo.request(get('b'));
    await memo.request(get('a'));
    await memo.request(get('b'));
    expect(registry.calls).toHaveLength(4);
  });
});

describe('a memo over a transport that cannot be asked again', () => {
  it.each([[undefined], [false]])(
    'keeps everything whatever the budget (refetchable: %s)',
    async (refetchable) => {
      const registry = new CountingRegistry(refetchable, {
        a: 400,
        b: 400,
        c: 400,
      });
      const memo = new MemoizingTransport(registry, {
        maximumRetainedBytes: 0,
      });
      expect(memo.refetchable).toBe(false);
      for (const name of ['a', 'b', 'c', 'a', 'b', 'c'])
        await memo.request(get(name));
      expect(registry.calls).toHaveLength(3);
      expect(memo.retention.evictions).toBe(0);
      expect(memo.retention.retainedBytes).toBe(1200);
    },
  );

  it('says it can be asked again when its transport can', () => {
    expect(
      new MemoizingTransport(new CountingRegistry(true, {})).refetchable,
    ).toBe(true);
  });
});

describe('the budget a person sets', () => {
  it('is 256 MiB unless said', () => {
    expect(retainedMetadataBytes({})).toBe(256 * MiB);
    expect(retainedMetadataBytes({ OPM_RETAINED_METADATA_MIB: '  ' })).toBe(
      256 * MiB,
    );
  });

  it('is whole MiB, zero, or unlimited', () => {
    expect(retainedMetadataBytes({ OPM_RETAINED_METADATA_MIB: '64' })).toBe(
      64 * MiB,
    );
    expect(retainedMetadataBytes({ OPM_RETAINED_METADATA_MIB: '0' })).toBe(0);
    expect(
      retainedMetadataBytes({ OPM_RETAINED_METADATA_MIB: 'Unlimited' }),
    ).toBe(Number.POSITIVE_INFINITY);
  });

  it.each(['-1', '1.5', '64MiB', 'lots', '1e3', '9999999999'])(
    'refuses %s rather than quietly removing the bound',
    (value) => {
      expect(() =>
        retainedMetadataBytes({ OPM_RETAINED_METADATA_MIB: value }),
      ).toThrow(
        /OPM_RETAINED_METADATA_MIB must be a whole number of MiB or "unlimited"/u,
      );
    },
  );
});
