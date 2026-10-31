import { describe, expect, it } from 'vitest';
import { decodeCloudEvent } from './index.js';

/**
 * An event a caller received is parsed under what an honest document of its
 * size may cost (`documentParseLimits`, sixteen times its bytes), so bytes that
 * would cost more are refused before they are built (ADR 0044, "Documents
 * other than packuments").
 */
describe('decoding an event', () => {
  it('refuses bytes that would cost more to hold than an event of that size', async () => {
    // 100 objects named by an index: 1.1 KB, charged 4 MB.
    const bytes = new TextEncoder().encode(
      JSON.stringify({
        data: Array.from({ length: 100 }, () => ({ '1023': 0 })),
      }),
    );
    // 16 times 1.1 KB is under the floor every document is allowed, 1 MiB.
    await expect(decodeCloudEvent(bytes)).rejects.toThrow(
      'JSON document exceeds 1048576 bytes of parsed size',
    );
  });
});
