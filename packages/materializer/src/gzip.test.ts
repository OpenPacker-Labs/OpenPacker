/**
 * The gzip decoder against Node's own `zlib.gunzipSync`, the decoder npm and
 * pnpm extract with: over a seeded corpus of members (every optional header
 * field), padding, junk and damage, it accepts exactly what Node accepts with
 * nothing but zeros after the bytes Node read, returns the same bytes, and
 * refuses everything else with the code the bytes call for. And the bound on
 * its output, at the bound.
 */

import { finished } from 'node:stream/promises';
import { createGunzip, gunzipSync, gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { concat, member, ours, text, type Outcome } from './gzip-fixture.js';
import { gunzipArchive } from './gzip.js';

/** Node's verdict: `gunzipSync`'s output, and how far its engine read. */
async function node(bytes: Uint8Array): Promise<Outcome> {
  try {
    const output = gunzipSync(bytes).toString('hex');
    const engine = createGunzip();
    engine.end(bytes);
    engine.resume();
    await finished(engine);
    return { accepted: true, output, end: engine.bytesWritten };
  } catch (error) {
    return {
      accepted: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * What a case calls for, from how it was built: accepted as Node accepts it,
 * refused where Node accepts it (a non-zero byte behind padding), or refused,
 * as Node refuses it, with this code.
 */
type Expected =
  | 'accepted'
  | 'stricter'
  | 'GZIP_TRAILING_DATA'
  | 'INVALID_COMPRESSION';

describe('the gzip decoder against Node', () => {
  it('accepts what Node accepts, unless a non-zero byte follows what Node read', async () => {
    let seed = 0x5eed;
    const random = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      return Math.floor((seed / 2 ** 31) * n);
    };
    const content = (n: number) =>
      Uint8Array.from({ length: n }, () => 97 + random(4));
    const tails: Array<[Expected, () => Uint8Array]> = [
      ['accepted', () => new Uint8Array(0)],
      ['accepted', () => new Uint8Array(1 + random(600))],
      ['GZIP_TRAILING_DATA', () => text('JUNK')],
      ['stricter', () => concat(new Uint8Array(1 + random(8)), text('J'))],
      ['INVALID_COMPRESSION', () => Uint8Array.of(0x1f, 0x8b, 0xff, 0xff)],
      ['GZIP_TRAILING_DATA', () => Uint8Array.of(0x1f)],
      [
        'INVALID_COMPRESSION',
        () => member(content(random(50)), random(32)).subarray(0, 12),
      ],
      ['accepted', () => member(content(random(50)), random(32))],
      ['accepted', () => concat(member(content(5), 0), new Uint8Array(4))],
    ];
    // A reserved flag, another method, the length, the CRC-32: zlib refuses
    // the first member, whatever follows it.
    const damage = (bytes: Uint8Array) => {
      const copy = Uint8Array.from(bytes);
      const at = [3, 2, bytes.byteLength - 1, bytes.byteLength - 5][random(4)]!;
      copy[at] = at === 3 ? copy[at]! | 0x20 : copy[at]! ^ 0x01;
      return copy;
    };
    const tally = { accepted: 0, stricter: 0, refused: 0, damaged: 0 };
    for (let index = 0; index < 400; index += 1) {
      const first = member(content(random(300)), random(32));
      const damaged = random(8) === 0;
      const [tailExpected, tail] = tails[random(tails.length)]!;
      const expected = damaged ? 'INVALID_COMPRESSION' : tailExpected;
      const bytes = concat(damaged ? damage(first) : first, tail());
      const [mine, theirs] = [await ours(bytes), await node(bytes)];
      const named = /the byte at offset (\d+) is 0x([0-9a-f]{2})/u.exec(
        mine.accepted ? '' : mine.message,
      );
      // Where a refusal names a byte, that byte is there and is not zero.
      if (named) {
        expect(bytes[Number(named[1])]).toBe(Number.parseInt(named[2]!, 16));
        expect(named[2]).not.toBe('00');
      }
      if (expected === 'accepted') {
        tally.accepted += 1;
        expect(mine).toMatchObject({ accepted: true });
        expect(theirs).toEqual(mine);
        expect(
          bytes
            .subarray(theirs.accepted ? theirs.end : 0)
            .every((byte) => byte === 0),
        ).toBe(true);
      } else if (expected === 'stricter') {
        tally.stricter += 1;
        expect(theirs).toMatchObject({ accepted: true });
        expect(mine).toMatchObject({ code: 'GZIP_TRAILING_DATA' });
      } else {
        tally.refused += 1;
        if (damaged) tally.damaged += 1;
        expect(theirs).toMatchObject({ accepted: false });
        expect(mine).toMatchObject({ accepted: false, code: expected });
        // zlib refused the first member: the refusal says so.
        if (damaged)
          expect(mine).toMatchObject({
            message: expect.stringContaining(
              'in the gzip member at offset 0',
            ) as string,
          });
      }
    }
    // Each kind of outcome is reached, so the comparison above was exercised.
    expect(
      Math.min(tally.accepted, tally.stricter, tally.refused, tally.damaged),
    ).toBeGreaterThan(20);
  });

  it('stops when its signal is aborted', async () => {
    const controller = new AbortController();
    const reason = new Error('stop');
    const pending = gunzipArchive(
      gzipSync(new Uint8Array(4 * 1024 * 1024)),
      8 * 1024 * 1024,
      controller.signal,
    );
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });
});

describe('the bound on what the decoder writes', () => {
  it('accepts exactly the limit and refuses one byte more, with the overflow code', async () => {
    const limit = 100_000;
    const exact = await gunzipArchive(gzipSync(new Uint8Array(limit)), limit);
    expect(exact.expanded.byteLength).toBe(limit);
    await expect(
      gunzipArchive(
        gzipSync(new Uint8Array(limit + 1)),
        limit,
        undefined,
        'OVER',
      ),
    ).rejects.toMatchObject({ code: 'OVER' });
  });

  it('refuses as the output arrives, not once the stream has ended', async () => {
    // Bytes zlib would only reach after 4 MiB of output: a bound checked at
    // the end would refuse them instead, as trailing data.
    const bytes = concat(gzipSync(new Uint8Array(4 << 20)), text('JUNK'));
    await expect(
      gunzipArchive(bytes, 1 << 20, undefined, 'OVER'),
    ).rejects.toMatchObject({ code: 'OVER' });
  });
});
