import { describe, expect, it } from 'vitest';
import { PackslipError, createBoundedFetcher } from '../src/index.js';

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
 * The addresses this package fetches come from a project name and from signed
 * documents, and a redirect names another. Each is read through the guard, so a
 * host no DNS name could be is refused in a few milliseconds and not the most of
 * a second the URL parser takes on 65,550 characters of it
 * (`@openpacker/canonical`'s `untrusted-url.test.ts` measures that), and the
 * refusal repeats none of it.
 */
const HOST = 'ß.é.'.repeat(16384);
const HOSTILE = `https://${HOST}/release.json`;
const FAST_MS = 50;

async function refusal(
  run: () => Promise<object | void>,
): Promise<{ error: PackslipError | undefined; ms: number }> {
  let error: PackslipError | undefined;
  let ms = Infinity;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const started = cpuMs();
    try {
      await run();
    } catch (caught) {
      if (caught instanceof PackslipError) error ??= caught;
      else throw caught;
    }
    ms = Math.min(ms, cpuMs() - started);
  }
  return { error, ms };
}

function fetcher(respond: (url: string) => Response, asked: string[] = []) {
  return createBoundedFetcher({
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    fetch: (async (input: URL | string) => {
      asked.push(String(input));
      return respond(String(input));
    }) as typeof fetch,
  });
}

describe('the bounded fetcher', () => {
  it('is not given an address whose host is longer than a name can be', async () => {
    const asked: string[] = [];
    const { error, ms } = await refusal(() =>
      fetcher(() => new Response('never asked'), asked).get(HOSTILE, {
        maxBytes: 100,
      }),
    );
    expect(error?.code).toBe('UNAVAILABLE');
    expect(error?.message).not.toContain('ß');
    expect(error?.message.length).toBeLessThan(200);
    expect(ms).toBeLessThan(FAST_MS);
    expect(asked).toEqual([]);
  });

  it.each([
    ['an address', HOSTILE],
    ['a network path', `//${HOST}/release.json`],
    ['a network path written with backslashes', `\\\\${HOST}\\release.json`],
  ])('does not follow a redirect to %s', async (_name, location) => {
    const asked: string[] = [];
    const { error, ms } = await refusal(() =>
      fetcher(
        () => new Response(null, { status: 302, headers: { location } }),
        asked,
      ).get('https://example.test/start', { maxBytes: 100 }),
    );
    expect(error?.code).toBe('UNAVAILABLE');
    expect(error?.message).not.toContain('ß');
    expect(error?.message.length).toBeLessThan(200);
    expect(ms).toBeLessThan(FAST_MS);
    expect(new Set(asked)).toEqual(new Set(['https://example.test/start']));
  });

  it('says that an address that is not a URL is one, without a stack', async () => {
    const { error } = await refusal(() =>
      fetcher(() => new Response('x')).get('not a url', { maxBytes: 100 }),
    );
    expect(error?.code).toBe('UNAVAILABLE');
    expect(error?.message).toBe('Not a URL: not a url');
  });

  it('still follows an ordinary redirect', async () => {
    const asked: string[] = [];
    const response = await fetcher(
      (url) =>
        url.endsWith('/start')
          ? new Response(null, { status: 302, headers: { location: '/next' } })
          : new Response('arrived'),
      asked,
    ).get('https://example.test/start', { maxBytes: 100 });
    expect(Buffer.from(response.bytes).toString()).toBe('arrived');
    expect(asked).toEqual([
      'https://example.test/start',
      'https://example.test/next',
    ]);
  });
});
