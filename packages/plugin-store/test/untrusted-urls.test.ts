import { expect, it } from 'vitest';
import { RegistryClient } from '@openpacker/registry-client';
import { PluginRegistryProvider, pluginRegistryModule } from '../src/index.js';

/**
 * The endpoint of a plugin registry is read through the guard: a host no DNS
 * name could be is refused in a few milliseconds and not the most of a second
 * the URL parser takes on 65,550 characters of it (`@openpacker/canonical`'s
 * `untrusted-url.test.ts` measures that), and the refusal repeats none of it.
 */
const HOST = 'ß.é.'.repeat(16384);

function refusal(run: () => void): { error: Error | undefined; ms: number } {
  let error: Error | undefined;
  let ms = Infinity;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const started = performance.now();
    try {
      run();
    } catch (caught) {
      error ??= caught instanceof Error ? caught : new Error(String(caught));
    }
    ms = Math.min(ms, performance.now() - started);
  }
  return { error, ms };
}

it('gives no module for an endpoint whose host is longer than a name can be', () => {
  const { error, ms } = refusal(() => {
    pluginRegistryModule().catalog?.({ endpoint: `https://${HOST}` });
  });
  expect(error).toBeInstanceOf(TypeError);
  expect(error?.message).not.toContain('ß');
  expect(error?.message.length).toBeLessThan(200);
  expect(ms).toBeLessThan(50);
});

it('gives no provider for such an endpoint either', () => {
  const client = new RegistryClient({ baseUrl: 'https://plugins.example' });
  const { error, ms } = refusal(() => {
    new PluginRegistryProvider(client, `https://${HOST}`);
  });
  expect(error).toBeInstanceOf(TypeError);
  expect(error?.message).not.toContain('ß');
  expect(ms).toBeLessThan(50);
});
