/**
 * Where zlib refuses a gzip stream, the refusal names the cause zlib found and
 * where: a member that does not decode (its header, its deflate data, its
 * header CRC, CRC-32 or length) at that member's offset, and bytes that are
 * neither zero nor a member at the offset they start. The walk that finds it
 * is held to its own output budget and member count, and an abort while it
 * runs is the abort.
 */

import { createGunzip, gunzipSync, gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  concat,
  FCOMMENT,
  FEXTRA,
  FHCRC,
  FNAME,
  member,
  memberHeader,
  ours,
  text,
} from './gzip-fixture.js';
import { describeRefusal, gunzipArchive, inflate } from './gzip.js';

const junk = text('JUNK');
const at = (offset: number) =>
  expect.stringContaining(`in the gzip member at offset ${offset}`) as string;
const follows = (offset: number) =>
  expect.stringContaining(
    `follow the gzip stream at offset ${offset};`,
  ) as string;
/** `bytes` with the byte `from` its end flipped. */
const flip = (bytes: Uint8Array, from: number) => {
  const copy = Uint8Array.from(bytes);
  copy[copy.byteLength - from] = copy[copy.byteLength - from]! ^ 0x01;
  return copy;
};

describe('a refusal names the member zlib refused', () => {
  const good = member(text('one'));
  it.each([
    ['its CRC-32', flip(member(text('two')), 5), 'incorrect data check'],
    ['its length', flip(member(text('two')), 1), 'incorrect length check'],
    [
      'its header CRC',
      concat(flip(memberHeader(FHCRC), 1), member(text('two')).subarray(10)),
      'header crc mismatch',
    ],
  ])('a member that fails %s, whatever follows it', async (_, bad, reason) => {
    const cases: Array<[Uint8Array, number]> = [
      [concat(bad, junk), 0],
      [concat(good, bad, junk), good.byteLength],
      [concat(good, bad, good, junk), good.byteLength],
    ];
    for (const [bytes, offset] of cases) {
      expect(() => gunzipSync(bytes)).toThrow(reason);
      expect(await ours(bytes)).toEqual({
        accepted: false,
        code: 'INVALID_COMPRESSION',
        message: `${reason}, in the gzip member at offset ${offset}`,
      });
    }
  });

  it('names junk after members with each optional header field alone', async () => {
    for (const flags of [FEXTRA, FNAME, FCOMMENT, FHCRC, 0x1e]) {
      const first = member(text('one'), flags);
      const second = member(text('two'), flags);
      expect(await ours(concat(first, second, junk))).toMatchObject({
        code: 'GZIP_TRAILING_DATA',
        message: follows(first.byteLength + second.byteLength),
      });
    }
  });

  it('names the member whose trailer is cut short', async () => {
    const good = gzipSync(text('abc'));
    const cut = gzipSync(text('abc')).subarray(0, -3);
    expect(await ours(concat(good, cut))).toMatchObject({
      code: 'INVALID_COMPRESSION',
      message: at(good.byteLength),
    });
  });

  it('names a member whose header zlib refuses', async () => {
    const good = member(text('one'));
    const reserved = Uint8Array.from(member(text('two')));
    reserved[3] = 0x20;
    expect(await ours(concat(good, reserved))).toMatchObject({
      code: 'INVALID_COMPRESSION',
      message: at(good.byteLength),
    });
  });

  it('says "1 byte follows" for one byte', async () => {
    const first = member(text('one'));
    expect(await ours(concat(first, text('A')))).toMatchObject({
      message: expect.stringContaining(
        `1 byte follows the gzip stream at offset ${first.byteLength}; the byte at offset ${first.byteLength} is 0x41`,
      ) as string,
    });
  });
});

describe('the walk is bounded', () => {
  const hundred = member(new Uint8Array(100));
  const bytes = concat(hundred, hundred, junk);

  it('stops, naming no offset, when its own output budget is spent', async () => {
    expect(await describeRefusal(bytes, 'zlib said no', 1000)).toMatchObject({
      code: 'GZIP_TRAILING_DATA',
    });
    expect(await describeRefusal(bytes, 'zlib said no', 150)).toMatchObject({
      code: 'INVALID_COMPRESSION',
      message: 'zlib said no',
    });
  });

  it('stops after 1,024 members', async () => {
    const empty = gzipSync(new Uint8Array(0));
    const many = concat(...Array.from({ length: 1100 }, () => empty));
    expect(await ours(concat(many, junk))).toEqual({
      accepted: false,
      code: 'INVALID_COMPRESSION',
      message: 'incorrect header check',
    });
    expect(await ours(concat(many, new Uint8Array(3)))).toMatchObject({
      accepted: true,
      end: many.byteLength,
    });
  });
});

describe('an abort while the walk runs', () => {
  const empty = gzipSync(new Uint8Array(0));
  const members = (count: number) =>
    concat(...Array.from({ length: count }, () => empty), junk);
  const stop = () => {
    const controller = new AbortController();
    return { controller, signal: controller.signal, reason: new Error('stop') };
  };
  /** Abort when `method` is called for the `nth` time: each inflate adds a listener as it starts and removes it as it ends. */
  const abortOn = (
    { controller, signal, reason }: ReturnType<typeof stop>,
    method: 'addEventListener' | 'removeEventListener',
    nth: number,
  ) => {
    const original: (
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ) => void = signal[method].bind(signal);
    let calls = 0;
    Object.defineProperty(signal, method, {
      value: (
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions,
      ) => {
        original(type, listener, options);
        calls += 1;
        if (calls === nth) controller.abort(reason);
      },
    });
  };

  it('is the abort, not a refusal that names a valid member', async () => {
    const run = stop();
    // zlib's own pass first, then the walk's first member: abort as its
    // second member starts.
    abortOn(run, 'addEventListener', 3);
    await expect(
      gunzipArchive(members(1023), 1 << 20, run.signal),
    ).rejects.toBe(run.reason);
  });

  it('is the abort when it lands inside a member the walk is inflating', async () => {
    const run = stop();
    abortOn(run, 'addEventListener', 2);
    await expect(
      describeRefusal(members(3), 'zlib said no', 1 << 20, run.signal),
    ).rejects.toBe(run.reason);
  });

  it('is the abort when the walk ends by its member count just after it', async () => {
    const run = stop();
    // zlib's own pass removes its listener first; the 1,024th member's
    // inflate removes the last one, and the walk then stops at its count.
    abortOn(run, 'removeEventListener', 1025);
    await expect(
      gunzipArchive(members(1024), 1 << 20, run.signal),
    ).rejects.toBe(run.reason);
  });

  it('is the abort at a step that inflates nothing', async () => {
    const run = stop();
    run.controller.abort(run.reason);
    await expect(
      describeRefusal(junk, 'zlib said no', 1 << 20, run.signal),
    ).rejects.toBe(run.reason);
  });

  it('is the abort when the signal was aborted before an inflate starts', async () => {
    const run = stop();
    run.controller.abort(run.reason);
    await expect(
      inflate(createGunzip(), gzipSync(text('abc')), 1 << 20, run.signal),
    ).rejects.toBe(run.reason);
  });
});
