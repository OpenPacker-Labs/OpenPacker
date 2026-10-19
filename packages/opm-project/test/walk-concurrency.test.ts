import { describe, expect, it } from 'vitest';
import {
  MAXIMUM_METADATA_BYTES,
  type HttpRequest,
  type HttpResponse,
  type HttpTransport,
} from '@openpacker/adapter-core';
import {
  MemoizingTransport,
  defaultHostEnvironment,
  resolveGraph,
} from '../src/index.js';
import {
  NpmRegistryFixture,
  type FixturePackage,
} from './npm-registry-fixture.js';

/**
 * The walk reads ahead and in parallel, and a resolve reads each document once.
 * What must not change is what it finds.
 */

const ok = (body: string, url: string, headers = {}): HttpResponse => ({
  status: 200,
  headers,
  body: new TextEncoder().encode(body),
  url,
});

/** A transport that answers after a delay and counts what is in flight. */
class SlowTransport implements HttpTransport {
  active = 0;
  peak = 0;
  calls: string[] = [];
  constructor(
    private readonly delay: (request: HttpRequest) => number,
    private readonly respond: (request: HttpRequest) => HttpResponse,
  ) {}
  async request(request: HttpRequest): Promise<HttpResponse> {
    this.calls.push(request.url);
    this.active += 1;
    this.peak = Math.max(this.peak, this.active);
    try {
      await new Promise((resolve) => setTimeout(resolve, this.delay(request)));
      return this.respond(request);
    } finally {
      this.active -= 1;
    }
  }
}

describe('MemoizingTransport', () => {
  const get = (url: string, headers: Record<string, string> = {}) => ({
    url,
    headers: { accept: 'application/json', ...headers },
    maximumBytes: 1024,
  });

  it('shares one request among concurrent reads of the same document', async () => {
    const inner = new SlowTransport(
      () => 5,
      (request) => ok('{"a":1}', request.url, { etag: '"v1"' }),
    );
    const transport = new MemoizingTransport(inner);
    const responses = await Promise.all([
      transport.request(get('https://r.test/a')),
      transport.request(get('https://r.test/a')),
      transport.request(get('https://r.test/a')),
    ]);
    expect(inner.calls).toEqual(['https://r.test/a']);
    expect(responses.map((response) => response.status)).toEqual([
      200, 200, 200,
    ]);
  });

  it('answers a revalidation with 304 and everything else with the kept 200', async () => {
    const inner = new SlowTransport(
      () => 0,
      (request) => ok('{"a":1}', request.url, { etag: '"v1"' }),
    );
    const transport = new MemoizingTransport(inner);
    await transport.request(get('https://r.test/a'));
    const revalidated = await transport.request(
      get('https://r.test/a', { 'if-none-match': '"v1"' }),
    );
    const stale = await transport.request(
      get('https://r.test/a', { 'if-none-match': '"other"' }),
    );
    expect(revalidated.status).toBe(304);
    expect(stale.status).toBe(200);
    expect(inner.calls).toHaveLength(1);
  });

  it('does not keep a failure, so the next read tries again', async () => {
    let attempts = 0;
    const inner: HttpTransport = {
      async request(request) {
        attempts += 1;
        if (attempts === 1) throw new Error('reset');
        return ok('{}', request.url);
      },
    };
    const transport = new MemoizingTransport(inner);
    await expect(transport.request(get('https://r.test/a'))).rejects.toThrow(
      'reset',
    );
    expect((await transport.request(get('https://r.test/a'))).status).toBe(200);
  });

  it('never keeps an artifact download', async () => {
    const inner = new SlowTransport(
      () => 0,
      (request) => ok('bytes', request.url),
    );
    const transport = new MemoizingTransport(inner);
    const download = {
      url: 'https://r.test/pkg.tgz',
      headers: { accept: 'application/octet-stream' },
      maximumBytes: 1024,
    };
    await transport.request(download);
    await transport.request(download);
    expect(inner.calls).toHaveLength(2);
  });

  it('keeps a document as large as an adapter may ask for, and no larger', async () => {
    // npm's packument for `typescript` is 8.7 MB and for `next` 25.6 MB. A
    // request is kept only if the bound it carries is no more than the
    // ceiling, so the ceiling cannot sit below what an adapter asks.
    const inner = new SlowTransport(
      () => 0,
      (request) => ok('{"a":1}', request.url, { etag: '"v1"' }),
    );
    const transport = new MemoizingTransport(inner);
    const atCeiling = {
      ...get('https://r.test/at'),
      maximumBytes: MAXIMUM_METADATA_BYTES,
    };
    await transport.request(atCeiling);
    await transport.request(atCeiling);
    const pastCeiling = {
      ...get('https://r.test/past'),
      maximumBytes: MAXIMUM_METADATA_BYTES + 1,
    };
    await transport.request(pastCeiling);
    await transport.request(pastCeiling);
    expect(inner.calls).toEqual([
      'https://r.test/at',
      'https://r.test/past',
      'https://r.test/past',
    ]);
    expect(MemoizingTransport.ENTRY_LIMIT).toBe(MAXIMUM_METADATA_BYTES);
    // What the memo may keep is a budget now (it was a total that stopped it
    // keeping anything more once reached): room for two of the largest.
    expect(MemoizingTransport.DEFAULT_RETAINED_BYTES).toBeGreaterThanOrEqual(
      2 * MemoizingTransport.ENTRY_LIMIT,
    );
  });

  it('bounds how many requests are in flight', async () => {
    const inner = new SlowTransport(
      () => 5,
      (request) => ok('{}', request.url),
    );
    const transport = new MemoizingTransport(inner);
    const urls = Array.from(
      { length: 60 },
      (_, index) => `https://r.test/${index}`,
    );
    const responses = await Promise.all(
      urls.map((url) => transport.request(get(url))),
    );
    expect(responses).toHaveLength(60);
    expect(inner.peak).toBeLessThanOrEqual(MemoizingTransport.CONCURRENCY);
    expect(inner.peak).toBeGreaterThan(1);
  });
});

describe('a walk that reads in parallel finds what a sequential one would', () => {
  /** A wide closure with a shared dependency and diamond ranges. */
  const registry = (): FixturePackage[] => [
    {
      name: 'app',
      versions: {
        '1.0.0': {
          dependencies: Object.fromEntries(
            Array.from({ length: 12 }, (_, index) => [`leaf-${index}`, '^1']),
          ),
        },
      },
    },
    ...Array.from({ length: 12 }, (_, index) => ({
      name: `leaf-${index}`,
      versions: {
        '1.0.0': { dependencies: { shared: '^1', [`deep-${index % 3}`]: '*' } },
        '1.1.0': {
          dependencies: { shared: '>=1.1.0', [`deep-${index % 3}`]: '*' },
        },
      },
    })),
    ...Array.from({ length: 3 }, (_, index) => ({
      name: `deep-${index}`,
      versions: { '1.0.0': { dependencies: { shared: '*' } } },
    })),
    { name: 'shared', versions: { '1.0.0': {}, '1.1.0': {}, '1.2.0': {} } },
  ];

  /** Delays the fixture registry by an amount that differs per URL and run. */
  const jittered = (seed: number) => {
    const inner = new NpmRegistryFixture(registry());
    return {
      async request(request: HttpRequest): Promise<HttpResponse> {
        let hash = seed;
        for (const character of request.url)
          hash = (hash * 31 + character.charCodeAt(0)) % 9973;
        await new Promise((resolve) => setTimeout(resolve, hash % 12));
        return inner.request(request);
      },
    } satisfies HttpTransport;
  };

  const walked = async (seed: number) => {
    const graph = await resolveGraph({
      roots: [{ purl: 'pkg:npm/app' }],
      options: { transport: jittered(seed) },
      host: defaultHostEnvironment(),
    });
    return {
      packages: graph.packages.map((item) => item.identity.exactPurl),
      unresolved: graph.unresolved,
      truncated: graph.truncated,
    };
  };

  it('returns the same packages in the same order however the reads interleave', async () => {
    const [first, ...others] = await Promise.all(
      [1, 2, 3, 4, 5, 6].map(walked),
    );
    expect(first!.packages.length).toBeGreaterThan(20);
    expect(first!.unresolved).toEqual([]);
    for (const other of others) expect(other).toEqual(first);
  });
});
