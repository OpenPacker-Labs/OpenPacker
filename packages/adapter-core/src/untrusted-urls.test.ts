import { describe, expect, it } from 'vitest';
import {
  BoundedFetchTransport,
  OverlongHostError,
  ProviderError,
  createFirstPartyTransport,
  createPinnedFetch,
  firstPartyOriginPolicy,
  normalizePinnedOrigin,
  parseUntrustedUrl,
} from './index.js';

/**
 * Milliseconds of CPU this process has spent, user and system: what the work
 * under test costs. A busy machine stretches the wall clock by every time slice
 * it takes away; it does not add to this.
 */
function cpuMs(): number {
  const { user, system } = process.cpuUsage();
  return (user + system) / 1000;
}

/**
 * Every place in this package that reads a URL out of text a registry or a
 * peer chose answers a host no DNS name could be without handing it to the URL
 * parser, which takes most of a second on 65,550 characters of it
 * (`@openpacker/canonical`'s `untrusted-url.test.ts` measures that). The time
 * is the thing under test: the real parser's cost is the reason for the guard,
 * and a refusal that arrives after it has run is not the guard.
 */
const HOST = 'ß.é.'.repeat(16384);
const HOSTILE = `https://${HOST}/p/-/p-1.0.0.tgz`;
const ORIGIN = 'https://registry.test';
const FAST_MS = 50;

/** What `run` throws or rejects with, and the least of three tries of how long that took. */
async function timed(
  run: () => void,
): Promise<{ error: Error | undefined; ms: number }> {
  let error: Error | undefined;
  let ms = Infinity;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const started = cpuMs();
    try {
      await run();
    } catch (caught) {
      error ??= caught instanceof Error ? caught : new Error(String(caught));
    }
    ms = Math.min(ms, cpuMs() - started);
  }
  return { error, ms };
}

async function expectProviderRefusal(run: () => void): Promise<void> {
  const { error, ms } = await timed(run);
  expect(error).toBeInstanceOf(ProviderError);
  if (!(error instanceof ProviderError)) return;
  expect(error.code).toBe('INVALID_PROVIDER_ENDPOINT');
  expect(error.message).not.toContain('ß');
  expect(error.message.length).toBeLessThan(200);
  expect(ms).toBeLessThan(FAST_MS);
}

/** The policy functions throw what the guard throws: a TypeError, with a fixed message. */
async function expectGuardRefusal(run: () => void): Promise<void> {
  const { error, ms } = await timed(run);
  expect(error).toBeInstanceOf(OverlongHostError);
  if (!(error instanceof OverlongHostError)) return;
  expect(error.message).not.toContain('ß');
  expect(ms).toBeLessThan(FAST_MS);
}

function transport(
  fetched: string[],
  respond: (url: string) => Response = () => new Response('ok'),
): BoundedFetchTransport {
  return new BoundedFetchTransport({
    allowedOrigins: [ORIGIN],
    destinationPolicy: 'classify-and-pin',
    lookup: async () => [{ address: '1.1.1.1', family: 4 }],
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    fetch: (async (input: Parameters<typeof fetch>[0]) => {
      const url = input instanceof URL ? input.href : String(input);
      fetched.push(url);
      return respond(url);
    }) as typeof fetch,
  });
}

describe('the transport reads no hostile URL', () => {
  it('refuses a request for an artifact location with a hostile host', async () => {
    const fetched: string[] = [];
    await expectProviderRefusal(() =>
      transport(fetched).request({ url: HOSTILE }),
    );
    expect(fetched).toEqual([]);
  });

  it('refuses a redirect whose Location has a hostile host', async () => {
    const fetched: string[] = [];
    const hop = transport(
      fetched,
      () => new Response(null, { status: 302, headers: { location: HOSTILE } }),
    );
    await expectProviderRefusal(() => hop.request({ url: `${ORIGIN}/a` }));
    expect(new Set(fetched)).toEqual(new Set([`${ORIGIN}/a`]));
  });

  it('refuses a network-path Location written without a scheme', async () => {
    const fetched: string[] = [];
    const hop = transport(
      fetched,
      () =>
        new Response(null, {
          status: 307,
          headers: { location: `//${HOST}/x` },
        }),
    );
    await expectProviderRefusal(() => hop.request({ url: `${ORIGIN}/a` }));
    expect(new Set(fetched)).toEqual(new Set([`${ORIGIN}/a`]));
  });

  it('refuses a hostile origin handed to it as an allowed or a pinned one', async () => {
    await expectProviderRefusal(
      () =>
        new BoundedFetchTransport({
          allowedOrigins: [`https://${HOST}`],
        }),
    );
    await expectProviderRefusal(() => normalizePinnedOrigin(`https://${HOST}`));
  });

  it('refuses the same address through a pinned fetch', async () => {
    const pinned = createPinnedFetch({
      allowedOrigins: [ORIGIN],
      lookup: async () => [{ address: '1.1.1.1', family: 4 }],
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      fetch: (async () => new Response('ok')) as typeof fetch,
    });
    await expectProviderRefusal(() => pinned(HOSTILE));
  });

  it('still follows an ordinary redirect, resolved against the request', async () => {
    const fetched: string[] = [];
    const hop = transport(fetched, (url) =>
      url.endsWith('/a')
        ? new Response(null, { status: 302, headers: { location: '/b' } })
        : new Response('arrived'),
    );
    const response = await hop.request({ url: `${ORIGIN}/a` });
    expect(Buffer.from(response.body).toString()).toBe('arrived');
    expect(fetched).toEqual([`${ORIGIN}/a`, `${ORIGIN}/b`]);
  });
});

describe('the first-party origin policy reads no hostile URL', () => {
  it('refuses a hostile endpoint', async () => {
    await expectGuardRefusal(() =>
      firstPartyOriginPolicy({ endpoint: HOSTILE, namedOrOverride: true }),
    );
    await expectGuardRefusal(() =>
      createFirstPartyTransport({ endpoint: HOSTILE, namedOrOverride: false }),
    );
  });

  it('refuses a hostile artifact origin', async () => {
    await expectGuardRefusal(() =>
      firstPartyOriginPolicy({
        endpoint: ORIGIN,
        namedOrOverride: false,
        artifactOrigins: ['https://cdn.test', HOSTILE],
      }),
    );
  });

  it('refuses a hostile extra origin of the transport', async () => {
    await expectProviderRefusal(() =>
      createFirstPartyTransport({
        endpoint: ORIGIN,
        namedOrOverride: false,
        extraOrigins: [HOSTILE],
      }),
    );
  });

  it('leaves an ordinary policy as it was', () => {
    expect(
      firstPartyOriginPolicy({
        endpoint: `${ORIGIN}/x`,
        namedOrOverride: false,
        artifactOrigins: ['https://cdn.test/y'],
        extraOrigins: ['https://extra.test'],
      }),
    ).toEqual({
      allowedOrigins: [ORIGIN, 'https://cdn.test', 'https://extra.test'],
      pinnedOrigins: [],
    });
  });
});

describe('the guard is the one that canonical exports', () => {
  it('is re-exported, not copied', () => {
    expect(() => parseUntrustedUrl(HOSTILE)).toThrow(TypeError);
  });
});
