import { describe, expect, it } from 'vitest';
import { createRegistry } from '../src/index.js';

/**
 * Fastify bounds a publish body's bytes (4 MiB by default); the parse bounds
 * what its tree costs, to what an honest document of that many bytes may
 * (`documentParseLimits`: 64 MiB). `{"1023":0}` is 10 bytes and an elements
 * store of 40 KB, so 4 MiB of it costs gigabytes (ADR 0044, "Documents other
 * than packuments").
 */

const registry = (bodyLimit?: number) =>
  createRegistry({
    registryId: 'urn:openpacker:registry:test',
    displayName: 'test registry',
    purlTypes: ['npm'],
    anonymousPublish: true,
    ...(bodyLimit !== undefined && { bodyLimit }),
  });

const indexNamed = (count: number): string =>
  JSON.stringify({
    manifest: { names: Array.from({ length: count }, () => ({ '1023': 0 })) },
  });

describe('what a request body may cost to parse', () => {
  it('refuses a body that costs more than one of the body limit may, as too large', async () => {
    const app = registry();
    try {
      // 10,000 objects in 110 KB: charged 400 MB.
      const response = await app.inject({
        method: 'POST',
        url: '/v1/publish',
        headers: { 'content-type': 'application/json' },
        payload: indexNamed(10_000),
      });
      expect(response.statusCode).toBe(413);
      expect(response.json()).toMatchObject({
        statusCode: 413,
        message: 'JSON document exceeds 67108864 bytes of parsed size',
      });
    } finally {
      await app.close();
    }
  });

  it('sets the limit by the body limit it was given', async () => {
    // A registry that takes 64 KB bodies may parse 1 MiB of tree, and 30 of the
    // objects (charged 1.2 MB) are past it.
    const app = registry(64 * 1024);
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/publish',
        headers: { 'content-type': 'application/json' },
        payload: indexNamed(30),
      });
      expect(response.statusCode).toBe(413);
      expect(response.json().message).toBe(
        'JSON document exceeds 1048576 bytes of parsed size',
      );
    } finally {
      await app.close();
    }
  });
});
