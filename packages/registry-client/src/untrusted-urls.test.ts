import { expect, it } from 'vitest';
import { RegistryClient } from './index.js';

/**
 * The base URL of a registry is read through the guard: a host no DNS name could
 * be is refused in a few milliseconds and not the most of a second the URL
 * parser takes on 65,550 characters of it (`@openpacker/canonical`'s
 * `untrusted-url.test.ts` measures that), and the refusal repeats none of it.
 */
const HOST = 'ß.é.'.repeat(16384);

it('is not given a base URL whose host is longer than a name can be', () => {
  let error: Error | undefined;
  let ms = Infinity;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const started = performance.now();
    try {
      new RegistryClient({ baseUrl: `https://${HOST}/registry` });
    } catch (caught) {
      error ??= caught instanceof Error ? caught : new Error(String(caught));
    }
    ms = Math.min(ms, performance.now() - started);
  }
  expect(error).toBeInstanceOf(TypeError);
  expect(error?.message).not.toContain('ß');
  expect(error?.message.length).toBeLessThan(200);
  expect(ms).toBeLessThan(50);
});

it('says an address that is not https once, as one line, when it is not hostile', () => {
  expect(
    () => new RegistryClient({ baseUrl: 'http://registry.example/\u001b[2K' }),
  ).toThrow(/^A registry must be https, or loopback for development: http:/u);
});
