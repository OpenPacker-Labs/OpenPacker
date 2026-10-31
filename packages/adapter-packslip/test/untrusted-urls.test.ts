import { describe, expect, it } from 'vitest';
import { PackslipError } from '@openpacker/packslip';
import { createNetwork } from '../src/index.js';

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
 * Every address this network is given came from a project name or a signed
 * document, and each redirect from the server it reached. They are read through
 * the guard, so a host no DNS name could be is refused in a few milliseconds
 * and not the most of a second the URL parser takes on 65,550 characters of it
 * (`@openpacker/canonical`'s `untrusted-url.test.ts` measures that), and the
 * refusal repeats none of it.
 */
const HOST = 'ß.é.'.repeat(16384);
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

describe('the network a provider uses', () => {
  it.each([
    ['an address', `https://${HOST}/release.json`],
    [
      'an address on the GitHub hosts of a lookalike',
      `https://github.com.${HOST}/x`,
    ],
  ])(
    'is given no %s whose host is longer than a name can be',
    async (_name, url) => {
      const asked: string[] = [];
      const network = createNetwork({
        // SAFETY: The surrounding boundary establishes the asserted domain contract.
        fetch: (async (input: URL | string) => {
          asked.push(String(input));
          return new Response('never asked');
        }) as typeof fetch,
        lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      });
      const { error, ms } = await refusal(() =>
        network.get(url, { maxBytes: 100 }),
      );
      expect(error?.code).toBe('UNAVAILABLE');
      expect(error?.message).not.toContain('ß');
      expect(error?.message.length).toBeLessThan(200);
      expect(ms).toBeLessThan(FAST_MS);
      expect(asked).toEqual([]);
    },
  );

  it('says what is not a URL as one line of at most 256 characters', async () => {
    const { error } = await refusal(() =>
      createNetwork({}).get(`not a url\u001b[2K\nopm: ok${'x'.repeat(400)}`, {
        maxBytes: 100,
      }),
    );
    expect(error?.code).toBe('UNAVAILABLE');
    expect(error?.message).toMatch(/^Not a URL: not a url/u);
    expect(error?.message.includes('\u001b')).toBe(false);
    expect(error?.message.includes('\n')).toBe(false);
    expect(error?.message.length).toBeLessThan(300);
  });
});
