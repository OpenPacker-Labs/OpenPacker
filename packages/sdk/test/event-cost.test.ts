import { describe, expect, it } from 'vitest';
import { OpenPackerClient } from '../src/index.js';

/**
 * A page of events is parsed under what an honest document of the page's byte
 * bound may cost, for the whole page (ADR 0044, "Documents other than
 * packuments"). The bytes are the server's: `{"1023":0}` is 10 of them and an
 * elements store of 40 KB.
 */

const indexNamed = (count: number): string =>
  JSON.stringify(Array.from({ length: count }, () => ({ '1023': 0 })));

const pageOf = (lines: readonly string[]) =>
  new OpenPackerClient({
    // A page of at most 64 KB may cost 1 MiB.
    maximumResponseBytes: 64 * 1024,
    fetch: async () =>
      new Response(`${lines.join('\n')}\n`, {
        headers: {
          'content-type': 'application/x-ndjson',
          'x-openpacker-next-cursor': '1',
        },
      }),
  });

describe('what a page of events may cost to hold', () => {
  it('refuses a line that costs more than the page may', async () => {
    // 1,000 objects in 11 KB, charged 40 MB.
    await expect(pageOf([indexNamed(1_000)]).eventPage()).rejects.toThrow(
      new RangeError(
        'PREX event page would cost more than 1048576 bytes to hold',
      ),
    );
  });

  it('counts the lines of a page together', async () => {
    // 15 objects are charged 600 KB: one line is under the page's 1 MiB, two
    // are over it.
    const line = indexNamed(15);
    await expect(pageOf([line]).eventPage()).resolves.toMatchObject({
      nextCursor: 1,
    });
    await expect(pageOf([line, line]).eventPage()).rejects.toThrow(
      /^PREX event page would cost more than 1048576 bytes to hold$/u,
    );
  });
});
