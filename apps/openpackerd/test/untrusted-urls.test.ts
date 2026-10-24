import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ArtifactDescriptor } from '@openpacker/contracts';
import { isLoopbackAuthority, isLoopbackOrigin } from '../src/loopback.js';
import { OperationError } from '../src/operations.js';
import { createFilesystemPublishStore } from '../src/publish-store.js';

/**
 * A request's Host and Origin, and the place a publisher says its artifact is,
 * are a network peer's text. Each is read through the guard: a host no DNS name
 * could be is refused in a few milliseconds and not the most of a second the
 * URL parser takes on 65,550 characters of it (`@openpacker/canonical`'s
 * `untrusted-url.test.ts` measures that), and the refusal repeats none of it.
 */
const HOST = 'ß.é.'.repeat(16384);
const FAST_MS = 50;

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('the daemon', () => {
  it.each([
    ['host', () => isLoopbackAuthority(`${HOST}:7337`)],
    ['origin', () => isLoopbackOrigin(`https://${HOST}`)],
  ])(
    'does not call a %s loopback when it names such a host',
    (_name, check) => {
      let best = Infinity;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const started = performance.now();
        expect(check()).toBe(false);
        best = Math.min(best, performance.now() - started);
      }
      expect(best).toBeLessThan(FAST_MS);
    },
  );

  it('still calls the loopback names loopback', () => {
    expect(isLoopbackAuthority('127.0.0.1:7337')).toBe(true);
    expect(isLoopbackAuthority('[::1]:7337')).toBe(true);
    expect(isLoopbackAuthority('LOCALHOST.:7337')).toBe(true);
    expect(isLoopbackOrigin('http://localhost:7337')).toBe(true);
    expect(isLoopbackAuthority('127.0.0.1.attacker.example')).toBe(false);
    expect(isLoopbackOrigin('https://attacker.example')).toBe(false);
  });

  it('refuses a published file location whose host is longer than a name can be', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openpackerd-untrusted-url-'));
    roots.push(root);
    const store = createFilesystemPublishStore({ root });
    const location = {
      transport: 'file' as const,
      uri: `file://${HOST}/artifact.tgz`,
      priority: 0,
      rangeSupported: true,
      annotations: {
        'openpacker.package.name': 'demo',
        'openpacker.package.version': '1.0.0',
        'openpacker.package.purlType': 'npm',
      },
    };
    const descriptor: ArtifactDescriptor = {
      descriptorId: `sha256:${'a'.repeat(64)}`,
      digest: { algorithm: 'sha256', value: 'a'.repeat(64) },
      size: 4,
      mediaType: 'application/vnd.npm.package+gzip',
      artifactType: 'application/vnd.npm.package+gzip',
      fileName: 'demo-1.0.0.tgz',
      nativeRole: 'distribution',
      locations: [location],
      referrers: [],
      externalRefs: [],
    };
    let error: unknown;
    let best = Infinity;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const started = performance.now();
      try {
        await store.publish(
          { descriptor, location },
          {
            signal: new AbortController().signal,
            correlationId: 'test',
            offline: false,
          },
        );
      } catch (caught) {
        error ??= caught;
      }
      best = Math.min(best, performance.now() - started);
    }
    expect(error).toBeInstanceOf(OperationError);
    expect(error).toMatchObject({ code: 'INVALID_REQUEST' });
    expect(String(error)).not.toContain('ß');
    expect(best).toBeLessThan(FAST_MS);
  });
});
