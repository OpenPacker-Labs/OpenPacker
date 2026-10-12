import { afterEach, describe, expect, it } from 'vitest';
import {
  ProviderError,
  type HttpRequest,
  type HttpResponse,
  type HttpTransport,
} from '@openpacker/adapter-core';
import {
  downloadArchive,
  mapPool,
  MemoryBudget,
  transportForSources,
} from '../src/frozen-fetch.js';

/** Stands for a credential a lock holds in an address. */
const CANARY = 'vtok_dummy_marker_0123456789abcdef';
const PUBLIC = [{ address: '104.16.0.1', family: 4 }];
const PRIVATE = [{ address: '10.0.0.7', family: 4 }];

function stubFetch(
  respond: (url: string) => Response | Promise<Response>,
): typeof fetch & { urls: string[] } {
  const urls: string[] = [];
  const stub = async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : String(input);
    urls.push(url);
    return respond(url);
  };
  return Object.assign(stub, { urls }) as typeof fetch & { urls: string[] };
}
const ok = () => new Response(new Uint8Array([1, 2, 3]));

describe('the transport a lock allows', () => {
  const saved = process.env.OPM_REGISTRY_NPM;
  afterEach(() => {
    if (saved === undefined) delete process.env.OPM_REGISTRY_NPM;
    else process.env.OPM_REGISTRY_NPM = saved;
  });

  it('reaches the origins the lock names and no other', async () => {
    const fetcher = stubFetch(ok);
    const transport = transportForSources(
      'npm',
      [
        'https://registry.npmjs.org/a/-/a-1.0.0.tgz',
        'https://npm.example.com/b/-/b-1.0.0.tgz',
      ],
      { fetch: fetcher, lookup: async () => PUBLIC },
    );
    const body = (
      await transport.request({
        url: 'https://npm.example.com/b/-/b-1.0.0.tgz',
      })
    ).body;
    expect([...body]).toEqual([1, 2, 3]);
    await expect(
      transport.request({ url: 'https://evil.example.net/a/-/a-1.0.0.tgz' }),
    ).rejects.toThrow(/not allowed|origin/iu);
    expect(fetcher.urls).toEqual(['https://npm.example.com/b/-/b-1.0.0.tgz']);
  });

  it('does not print the userinfo, query or fragment of a source it cannot fetch', () => {
    const source = `https://u:${CANARY}@ho st/x.tgz?q=${CANARY}#${CANARY}`;
    let message = '';
    try {
      transportForSources('npm', [source], {});
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe('https://ho st/x.tgz is not a URL opm can fetch');
    expect(message).not.toContain(CANARY);
  });

  it('does not follow a redirect to a host the lock did not name', async () => {
    const fetcher = stubFetch(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://evil.example.net/steal.tgz' },
        }),
    );
    const transport = transportForSources(
      'npm',
      ['https://registry.npmjs.org/a/-/a-1.0.0.tgz'],
      { fetch: fetcher, lookup: async () => PUBLIC },
    );
    await expect(
      transport.request({ url: 'https://registry.npmjs.org/a/-/a-1.0.0.tgz' }),
    ).rejects.toThrow(/not allowed|origin/iu);
    expect(fetcher.urls).toHaveLength(1);
  });

  it('refuses a public registry that resolves to a private address', async () => {
    const fetcher = stubFetch(ok);
    const transport = transportForSources(
      'npm',
      ['https://registry.npmjs.org/a/-/a-1.0.0.tgz'],
      { fetch: fetcher, lookup: async () => PRIVATE },
    );
    await expect(
      transport.request({ url: 'https://registry.npmjs.org/a/-/a-1.0.0.tgz' }),
    ).rejects.toThrow();
    expect(fetcher.urls).toEqual([]);
  });

  it('lets an origin the operator named resolve to a private address', async () => {
    process.env.OPM_REGISTRY_NPM = 'https://npm.internal.example';
    const fetcher = stubFetch(ok);
    const transport = transportForSources(
      'npm',
      ['https://npm.internal.example/a/-/a-1.0.0.tgz'],
      { fetch: fetcher, lookup: async () => PRIVATE },
    );
    await expect(
      transport.request({
        url: 'https://npm.internal.example/a/-/a-1.0.0.tgz',
      }),
    ).resolves.toMatchObject({ status: 200 });
  });

  it('does not pin an origin the operator named if the lock does not use it', async () => {
    process.env.OPM_REGISTRY_NPM = 'https://npm.internal.example';
    const transport = transportForSources(
      'npm',
      ['https://registry.npmjs.org/a/-/a-1.0.0.tgz'],
      { fetch: stubFetch(ok), lookup: async () => PRIVATE },
    );
    await expect(
      transport.request({ url: 'https://registry.npmjs.org/a/-/a-1.0.0.tgz' }),
    ).rejects.toThrow();
  });

  it('refuses a source that is not an https address', () => {
    expect(() =>
      transportForSources('npm', ['http://registry.example.com/a.tgz'], {}),
    ).toThrow(/will not fetch from/u);
    expect(() => transportForSources('npm', ['not a url'], {})).toThrow(
      /not a URL opm can fetch/u,
    );
  });
});

describe('downloadArchive', () => {
  const transportOf = (
    behave: (call: number) => HttpResponse | Error,
  ): HttpTransport & { calls: number } => {
    const transport = {
      calls: 0,
      async request(_request: HttpRequest): Promise<HttpResponse> {
        transport.calls += 1;
        const result = behave(transport.calls);
        if (result instanceof Error) throw result;
        return result;
      },
    };
    return transport;
  };
  const good: HttpResponse = {
    status: 200,
    headers: {},
    body: new Uint8Array([9]),
    url: 'u',
  };

  it('tries again when the network, not the registry, failed', async () => {
    const transport = transportOf((call) =>
      call < 3 ? new TypeError('fetch failed') : good,
    );
    await expect(
      downloadArchive(transport, 'https://r.example/a.tgz', 'a@1.0.0'),
    ).resolves.toEqual(good.body);
    expect(transport.calls).toBe(3);
  });

  it('gives up after three attempts, naming the package and where it asked', async () => {
    const transport = transportOf(() => new TypeError('fetch failed'));
    await expect(
      downloadArchive(
        transport,
        'https://u:p@r.example/a.tgz?t=secret',
        'a@1.0.0',
      ),
    ).rejects.toMatchObject({
      code: 'FETCH_FAILED',
      message: expect.stringMatching(
        /Failed to fetch a@1\.0\.0 from https:\/\/r\.example\/a\.tgz: fetch failed/u,
      ),
    });
    expect(transport.calls).toBe(3);
  });

  it('does not print the credentials of an address a URL parser refuses', async () => {
    const transport = transportOf(() => new TypeError('fetch failed'));
    const error = await downloadArchive(
      transport,
      `https://u:${CANARY}@ho st/a.tgz?t=${CANARY}#${CANARY}`,
      'a@1.0.0',
    ).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: 'FETCH_FAILED',
      message: 'Failed to fetch a@1.0.0 from https://ho st/a.tgz: fetch failed',
    });
  });

  it('does not retry an answer', async () => {
    const transport = transportOf(
      () => new ProviderError('ARTIFACT_NOT_FOUND', 'gone', 404),
    );
    await expect(
      downloadArchive(transport, 'https://r.example/a.tgz', 'a@1.0.0'),
    ).rejects.toMatchObject({ code: 'FETCH_FAILED' });
    expect(transport.calls).toBe(1);
  });
});

describe('mapPool', () => {
  it('keeps the order of the items and bounds how many run at once', async () => {
    let running = 0;
    let peak = 0;
    const out = await mapPool([5, 1, 4, 2, 3, 0], 2, async (item) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, item));
      running -= 1;
      return item * 10;
    });
    expect(out).toEqual([50, 10, 40, 20, 30, 0]);
    expect(peak).toBe(2);
  });

  it('stops starting work after a failure and reports the first one', async () => {
    const started: number[] = [];
    await expect(
      mapPool([0, 1, 2, 3, 4, 5], 1, async (item) => {
        started.push(item);
        if (item === 2) throw new Error('boom');
        return item;
      }),
    ).rejects.toThrow('boom');
    expect(started).toEqual([0, 1, 2]);
  });

  it('handles nothing', async () => {
    await expect(mapPool([], 4, async () => 1)).resolves.toEqual([]);
  });
});

describe('MemoryBudget', () => {
  it('lets work run together while it fits and holds the rest back', async () => {
    const budget = new MemoryBudget(100);
    let running = 0;
    let peak = 0;
    const job = (need: number) =>
      budget.hold(need, async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running -= 1;
      });
    await Promise.all([job(40), job(40), job(40), job(40)]);
    expect(peak).toBe(2);
  });

  it('runs work that needs more than the pool holds, alone', async () => {
    const budget = new MemoryBudget(100);
    let running = 0;
    let peak = 0;
    const job = (need: number) =>
      budget.hold(need, async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running -= 1;
      });
    await Promise.all([job(1000), job(10), job(1000)]);
    expect(peak).toBe(1);
  });

  it('does not let a large job starve behind small ones', async () => {
    const budget = new MemoryBudget(100);
    const order: string[] = [];
    const job = (label: string, need: number) =>
      budget.hold(need, async () => {
        order.push(label);
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
    await Promise.all([
      job('a', 60),
      job('big', 90),
      job('b', 30),
      job('c', 30),
    ]);
    expect(order.indexOf('big')).toBeLessThan(order.indexOf('b'));
  });

  it('frees what a failed job held', async () => {
    const budget = new MemoryBudget(10);
    await expect(
      budget.hold(10, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await expect(budget.hold(10, async () => 'ok')).resolves.toBe('ok');
  });
});
