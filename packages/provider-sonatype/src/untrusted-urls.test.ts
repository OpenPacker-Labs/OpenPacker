import { expect, it } from 'vitest';
import { FixtureHttpTransport } from '@openpacker/adapter-core';
import { SonatypeProvider } from './index.js';

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
 * The endpoint of an enrichment service is read through the guard: a host no
 * DNS name could be is refused in a few milliseconds and not the most of a
 * second the URL parser takes on 65,550 characters of it
 * (`@openpacker/canonical`'s `untrusted-url.test.ts` measures that), and the
 * refusal repeats none of it.
 */
const HOST = 'ß.é.'.repeat(16384);

it('is not given an endpoint whose host is longer than a name can be', () => {
  let error: Error | undefined;
  let ms = Infinity;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const started = cpuMs();
    try {
      new SonatypeProvider(
        new FixtureHttpTransport(new Map()),
        { resolve: async () => ({ authorization: 'Bearer fixture' }) },
        { now: () => '2026-08-02T00:00:00Z' },
        `https://${HOST}`,
        'secret://sonatype/test',
      );
    } catch (caught) {
      error ??= caught instanceof Error ? caught : new Error(String(caught));
    }
    ms = Math.min(ms, cpuMs() - started);
  }
  expect(error).toBeInstanceOf(TypeError);
  expect(error?.message).not.toContain('ß');
  expect(error?.message.length).toBeLessThan(200);
  expect(ms).toBeLessThan(50);
});
