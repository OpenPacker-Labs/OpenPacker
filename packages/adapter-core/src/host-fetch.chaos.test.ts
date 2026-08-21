import { describe, expect, it } from 'vitest';
import { BoundedFetchTransport } from './index.js';

/**
 * Chaos at the host-fetch transport boundary: lookup faults, fetch faults,
 * truncated redirects, and upstream outages must fail closed without a GET
 * succeeding on a poisoned hop.
 */
describe('host-fetch transport chaos', () => {
  const origin = 'https://registry.test';

  it('fails closed when DNS lookup throws', async () => {
    let fetched = false;
    const transport = new BoundedFetchTransport({
      allowedOrigins: [origin],
      destinationPolicy: 'classify-and-pin',
      lookup: async () => {
        throw new Error('resolver exploded');
      },
      fetch: (async () => {
        fetched = true;
        return new Response('ok');
      }) as typeof fetch,
    });
    await expect(transport.request({ url: `${origin}/data` })).rejects.toThrow(
      /resolver exploded/u,
    );
    expect(fetched).toBe(false);
  });

  it('fails closed when native fetch rejects', async () => {
    const transport = new BoundedFetchTransport({
      allowedOrigins: [origin],
      destinationPolicy: 'classify-and-pin',
      lookup: async () => [{ address: '1.1.1.1', family: 4 }],
      fetch: (async () => {
        throw new Error('socket reset');
      }) as typeof fetch,
    });
    await expect(transport.request({ url: `${origin}/data` })).rejects.toThrow(
      /socket reset/u,
    );
  });

  it('fails closed on a redirect that omits Location', async () => {
    let fetched = 0;
    const transport = new BoundedFetchTransport({
      allowedOrigins: [origin],
      destinationPolicy: 'classify-and-pin',
      lookup: async () => [{ address: '1.1.1.1', family: 4 }],
      fetch: (async () => {
        fetched += 1;
        return new Response(null, { status: 302 });
      }) as typeof fetch,
    });
    await expect(
      transport.request({ url: `${origin}/data` }),
    ).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
    expect(fetched).toBe(1);
  });

  it('fails closed on a persistent 503', async () => {
    let fetched = 0;
    const transport = new BoundedFetchTransport({
      allowedOrigins: [origin],
      destinationPolicy: 'classify-and-pin',
      lookup: async () => [{ address: '1.1.1.1', family: 4 }],
      fetch: (async () => {
        fetched += 1;
        return new Response(null, { status: 503 });
      }) as typeof fetch,
      delay: async () => undefined,
    });
    await expect(
      transport.request({ url: `${origin}/data` }),
    ).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
    expect(fetched).toBeGreaterThan(1);
  });

  it('fails closed when the published bound is exceeded', async () => {
    const transport = new BoundedFetchTransport({
      allowedOrigins: [origin],
      destinationPolicy: 'classify-and-pin',
      lookup: async () => [{ address: '1.1.1.1', family: 4 }],
      maximumBytes: 4,
      fetch: (async () => new Response('too-big')) as typeof fetch,
    });
    await expect(
      transport.request({ url: `${origin}/data` }),
    ).rejects.toMatchObject({ code: 'UPSTREAM_RESPONSE_TOO_LARGE' });
  });
});
