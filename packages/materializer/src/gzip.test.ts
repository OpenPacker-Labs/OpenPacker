/**
 * The gzip decoder against Node's own `zlib.gunzipSync`, the decoder npm and
 * pnpm extract with: over a seeded corpus of members (every optional header
 * field), padding, junk and damage, it accepts exactly what Node accepts with
 * nothing but zeros after the bytes Node read, returns the same bytes, and
 * refuses everything else.
 */

import { finished } from 'node:stream/promises';
import {
  crc32,
  createGunzip,
  deflateRawSync,
  gunzipSync,
  gzipSync,
} from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { gunzipArchive } from './gzip.js';

const text = (value: string) => new TextEncoder().encode(value);
const concat = (...parts: Uint8Array[]) => new Uint8Array(Buffer.concat(parts));
const le = (value: number, bytes: number) =>
  Uint8Array.from(
    { length: bytes },
    (_, index) => (value >>> (8 * index)) & 0xff,
  );

/** A gzip member with the optional header fields `flags` names (RFC 1952). */
function member(content: Uint8Array, flags: number): Uint8Array {
  const parts = [Uint8Array.of(0x1f, 0x8b, 8, flags, 0, 0, 0, 0, 0, 3)];
  if ((flags & 0x04) !== 0) parts.push(le(3, 2), text('xyz'));
  if ((flags & 0x08) !== 0) parts.push(text('name.tar'), Uint8Array.of(0));
  if ((flags & 0x10) !== 0) parts.push(text('a comment'), Uint8Array.of(0));
  if ((flags & 0x02) !== 0) parts.push(le(crc32(concat(...parts)) & 0xffff, 2));
  return concat(
    ...parts,
    deflateRawSync(content),
    le(crc32(content), 4),
    le(content.byteLength, 4),
  );
}

type Outcome =
  | { accepted: true; output: string; end: number }
  | { accepted: false; code?: string | undefined; message: string };

async function ours(bytes: Uint8Array): Promise<Outcome> {
  return gunzipArchive(bytes, 1 << 20).then(
    ({ expanded, streamEnd }) => ({
      accepted: true as const,
      output: Buffer.from(expanded).toString('hex'),
      end: streamEnd,
    }),
    (error: Error & { code?: string }) => ({
      accepted: false as const,
      code: error.code,
      message: error.message,
    }),
  );
}

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

describe('the gzip decoder against Node', () => {
  it('accepts what Node accepts, unless a non-zero byte follows what Node read', async () => {
    let seed = 0x5eed;
    const random = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      return Math.floor((seed / 2 ** 31) * n);
    };
    const content = (n: number) =>
      Uint8Array.from({ length: n }, () => 97 + random(4));
    const tails: Array<() => Uint8Array> = [
      () => new Uint8Array(0),
      () => new Uint8Array(1 + random(600)),
      () => text('JUNK'),
      () => concat(new Uint8Array(1 + random(8)), text('J')),
      () => Uint8Array.of(0x1f, 0x8b, 0xff, 0xff),
      () => Uint8Array.of(0x1f),
      () => member(content(random(50)), random(32)).subarray(0, 12),
      () => member(content(random(50)), random(32)),
      () => concat(member(content(5), 0), new Uint8Array(4)),
    ];
    const damage = (bytes: Uint8Array) => {
      const copy = Uint8Array.from(bytes);
      const at = [3, 2, bytes.byteLength - 1, bytes.byteLength - 5][random(4)]!;
      copy[at] = at === 3 ? copy[at]! | 0x20 : copy[at]! ^ 0x01;
      return copy;
    };
    const tally = { accepted: 0, stricter: 0, refused: 0 };
    for (let index = 0; index < 400; index += 1) {
      const first = member(content(random(300)), random(32));
      const bytes = concat(
        random(8) === 0 ? damage(first) : first,
        tails[random(tails.length)]!(),
      );
      const [mine, theirs] = [await ours(bytes), await node(bytes)];
      const named = /the byte at offset (\d+) is 0x([0-9a-f]{2})/u.exec(
        mine.accepted ? '' : mine.message,
      );
      // Where a refusal names a byte, that byte is there and is not zero.
      if (named) {
        expect(bytes[Number(named[1])]).toBe(Number.parseInt(named[2]!, 16));
        expect(named[2]).not.toBe('00');
      }
      if (mine.accepted) {
        tally.accepted += 1;
        expect(theirs).toEqual(mine);
        expect(bytes.subarray(mine.end).every((byte) => byte === 0)).toBe(true);
      } else if (theirs.accepted) {
        tally.stricter += 1;
        expect(mine.code).toBe('GZIP_TRAILING_DATA');
        expect(bytes.subarray(theirs.end).some((byte) => byte !== 0)).toBe(
          true,
        );
      } else {
        tally.refused += 1;
        expect(mine.code).toMatch(
          /^(?:GZIP_TRAILING_DATA|INVALID_COMPRESSION)$/u,
        );
      }
    }
    // Each kind of outcome is reached, so the comparison above was exercised.
    expect(
      Math.min(tally.accepted, tally.stricter, tally.refused),
    ).toBeGreaterThan(20);
  });

  it('names the offset of junk after members with every optional header field', async () => {
    const first = member(text('one'), 0x1e);
    const second = member(text('two'), 0x0e);
    const junk = concat(first, second, text('JUNK'));
    expect(() => gunzipSync(junk)).toThrow(/incorrect header check/u);
    expect(await ours(concat(first, second, new Uint8Array(9)))).toMatchObject({
      accepted: true,
      output: Buffer.from('onetwo').toString('hex'),
      end: first.byteLength + second.byteLength,
    });
    expect(await ours(junk)).toMatchObject({
      code: 'GZIP_TRAILING_DATA',
      message: expect.stringContaining(
        `4 bytes follow the gzip stream at offset ${first.byteLength + second.byteLength}`,
      ) as string,
    });
  });

  it('names the member that does not decode', async () => {
    const first = member(text('one'), 0);
    const bad = member(text('two'), 0x02);
    bad[bad.byteLength - 6] = bad[bad.byteLength - 6]! ^ 0x01;
    expect(await ours(concat(first, bad))).toMatchObject({
      code: 'INVALID_COMPRESSION',
      message: expect.stringMatching(
        new RegExp(`^incorrect data check`, 'u'),
      ) as string,
    });
    const header = Uint8Array.from(bad);
    header[3] = 0x22;
    expect(await ours(concat(first, header))).toMatchObject({
      code: 'INVALID_COMPRESSION',
      message: expect.stringContaining(
        `in the gzip member at offset ${first.byteLength}`,
      ) as string,
    });
  });

  it('stops wording a refusal after 1,024 members', async () => {
    const empty = gzipSync(new Uint8Array(0));
    const many = concat(...Array.from({ length: 1100 }, () => empty));
    expect(await ours(concat(many, text('JUNK')))).toEqual({
      accepted: false,
      code: 'INVALID_COMPRESSION',
      message: 'incorrect header check',
    });
    expect(await ours(concat(many, new Uint8Array(3)))).toMatchObject({
      accepted: true,
      end: many.byteLength,
    });
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
