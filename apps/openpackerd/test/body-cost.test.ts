import { describe, expect, it } from 'vitest';
import { createOpenPackerDaemon } from '../src/index.js';
import { createStandaloneReferenceOperations } from '../src/reference.js';

/**
 * Fastify bounds a request body's bytes (`requestBytes`, 1 MiB); the parse
 * bounds what its tree costs, to what an honest document of that many bytes
 * may (`documentParseLimits`: 16 MiB). `{"1023":0}` is 10 bytes and an elements
 * store of 40 KB, so a megabyte of it ends a process with a heap of 1 GiB
 * (ADR 0044, "Documents other than packuments").
 */

// 10,000 objects named by an index in 110 KB: charged 400 MB, and about 125
// MB to build whole.
const hostile = JSON.stringify({
  request: Array.from({ length: 10_000 }, () => ({ '1023': 0 })),
});

describe('what a request body may cost to parse', () => {
  it('refuses a body that costs more than one of the body limit may, as too large', async () => {
    const app = createOpenPackerDaemon({
      operations: await createStandaloneReferenceOperations(),
    });
    try {
      expect(hostile.length).toBeLessThan(1024 * 1024);
      const response = await app.inject({
        method: 'POST',
        url: '/v1/identify',
        headers: { 'content-type': 'application/json' },
        payload: hostile,
      });
      expect(response.statusCode).toBe(413);
      expect(response.json()).toMatchObject({
        status: 413,
        code: 'INVALID_REQUEST',
        detail: 'JSON document exceeds 16777216 bytes of parsed size',
      });
    } finally {
      await app.close();
    }
  });

  it('sets the limit by the body limit it was given', async () => {
    // A daemon that takes 64 KB bodies may parse 1 MiB of tree, and 30 of the
    // objects (330 bytes, charged 1.2 MB) are past it.
    const small = createOpenPackerDaemon({
      operations: await createStandaloneReferenceOperations(),
      bodyLimit: 64 * 1024,
    });
    const body = JSON.stringify({
      request: Array.from({ length: 30 }, () => ({ '1023': 0 })),
    });
    try {
      const refused = await small.inject({
        method: 'POST',
        url: '/v1/identify',
        headers: { 'content-type': 'application/json' },
        payload: body,
      });
      expect(refused.statusCode).toBe(413);
      expect(refused.json()).toMatchObject({
        status: 413,
        code: 'INVALID_REQUEST',
        detail: 'JSON document exceeds 1048576 bytes of parsed size',
      });
    } finally {
      await small.close();
    }
  });

  it('answers a body past the byte limit as it answers one past the cost, too large', async () => {
    const app = createOpenPackerDaemon({
      operations: await createStandaloneReferenceOperations(),
      bodyLimit: 1024,
    });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/identify',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ request: 'x'.repeat(2000) }),
      });
      expect(response.statusCode).toBe(413);
      expect(response.json()).toMatchObject({
        status: 413,
        code: 'INVALID_REQUEST',
      });
    } finally {
      await app.close();
    }
  });
});
