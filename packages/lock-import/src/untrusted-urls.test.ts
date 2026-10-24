import { describe, expect, it } from 'vitest';
import { configureDefaultAdapters } from '@openpacker/adapters-default';
import { planLockCapture } from './index.js';

/**
 * A lock file is text someone else wrote, and `resolved` is a URL in it. The
 * importer reads it through the guard, so a host no DNS name could be costs a
 * few milliseconds and not most of a second (the URL parser takes the square of
 * the length of 65,550 characters of it; `@openpacker/canonical`'s
 * `untrusted-url.test.ts` measures that), and it is named as the meaning the
 * import lost without the lock's text being repeated.
 */
const HOST = 'ß.é.'.repeat(16384);
const FAST_MS = 50;

configureDefaultAdapters();

const integrity = `sha512-${Buffer.from('a'.repeat(64)).toString('base64')}`;
const lock = (resolved: string) =>
  JSON.stringify({
    name: 'app',
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name: 'app', version: '1.0.0' },
      'node_modules/a': { version: '1.0.0', resolved, integrity },
    },
  });

async function plan(resolved: string) {
  let best = Infinity;
  let result: Awaited<ReturnType<typeof planLockCapture>> | undefined;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const started = performance.now();
    result = await planLockCapture(lock(resolved));
    best = Math.min(best, performance.now() - started);
  }
  if (result === undefined) throw new Error('no plan');
  return { result, ms: best };
}

describe('a lock whose resolved names a host no DNS name could be', () => {
  it.each([
    ['https', `https://${HOST}/a/-/a-1.0.0.tgz`],
    ['a network path behind a scheme', `https:\\\\${HOST}\\a.tgz`],
    ['userinfo', `https://u:p@${HOST}/a.tgz`],
  ])('imports no location for %s, in under 50 ms', async (_name, resolved) => {
    const { result, ms } = await plan(resolved);
    expect(ms).toBeLessThan(FAST_MS);
    const instance = result.packages[0];
    const loss = instance?.semanticLoss.find(
      (item) => item.code === 'NATIVE_ARTIFACT_LOCATION_NOT_HTTPS',
    );
    expect(loss).toBeDefined();
    expect(loss?.originalMeaning).not.toContain('ß');
    expect(loss?.originalMeaning.length).toBeLessThan(400);
  });

  it('still imports the location of an ordinary address', async () => {
    const { result } = await plan('https://registry.npmjs.org/a/-/a-1.0.0.tgz');
    expect(
      result.packages[0]?.semanticLoss.some(
        (item) => item.code === 'NATIVE_ARTIFACT_LOCATION_NOT_HTTPS',
      ),
    ).toBe(false);
  });
});
