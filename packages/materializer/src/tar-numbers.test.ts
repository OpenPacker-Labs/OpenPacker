/**
 * The numeric fields node-tar decodes and the other two readers do not
 * (ADR 0058 §8): which fields, under what magic, and which base-256 numbers it
 * can read. The archives that show npm and pnpm part over them are in
 * test/tar-oracle (tar-end.test.ts).
 */

import { describe, expect, it } from 'vitest';
import { assertNumbersAgree } from './tar-numbers.js';

const header = (field: number, bytes: number[], atZero475 = true) => {
  const block = new Uint8Array(512);
  block.set(bytes, field);
  if (!atZero475) block[475] = 0x41;
  return block;
};
const refused = (block: Uint8Array, ustar = true) => {
  try {
    assertNumbersAgree(block, 0, ustar);
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
};

describe('the numeric fields only node-tar decodes', () => {
  it('refuses a high-bit field that is neither 0x80 nor 0xff led', () => {
    for (const [field, name] of [
      [108, 'uid'],
      [116, 'gid'],
      [136, 'mtime'],
      [329, 'devmajor'],
      [337, 'devminor'],
      [476, 'atime'],
      [488, 'ctime'],
    ] as const)
      expect(refused(header(field, [0x81])), name).toBe('TAR_AMBIGUOUS_NUMBER');
  });

  it('reads atime and ctime only when byte 475 is zero, devmajor and devminor only under ustar magic', () => {
    expect(refused(header(476, [0x81], false))).toBeUndefined();
    expect(refused(header(488, [0x81], false))).toBeUndefined();
    expect(refused(header(329, [0x81]), false)).toBeUndefined();
    expect(refused(header(337, [0x81]), false)).toBeUndefined();
    expect(refused(header(108, [0x81]), false)).toBe('TAR_AMBIGUOUS_NUMBER');
    expect(refused(header(476, [0x81]), false)).toBeUndefined();
  });

  it('accepts what node-tar decodes: 0x80 and 0xff led numbers, plain octal, empty', () => {
    expect(refused(header(108, [0x80, 0, 0, 0, 0, 0, 0, 5]))).toBeUndefined();
    expect(refused(header(136, Array(12).fill(0xff)))).toBeUndefined();
    expect(refused(header(108, [0x30, 0x30]))).toBeUndefined();
    expect(refused(header(108, []))).toBeUndefined();
  });

  it('holds a positive number to the safe integers, 2^53 - 1 in and 2^53 out', () => {
    const field = (top: number) => [
      0x80,
      top,
      0xff,
      0xff,
      0xff,
      0xff,
      0xff,
      0xff,
    ];
    expect(refused(header(108, field(0x1f)))).toBeUndefined();
    expect(refused(header(108, [0x80, 0x20, 0, 0, 0, 0, 0, 0]))).toBe(
      'TAR_AMBIGUOUS_NUMBER',
    );
  });

  it('holds a negative number to the safe integers, -1 and -(2^53 - 1) in, -2^53 and -2^56 out', () => {
    expect(refused(header(108, Array(8).fill(0xff)))).toBeUndefined();
    expect(
      refused(header(108, [0xff, 0xe0, 0, 0, 0, 0, 0, 1])),
    ).toBeUndefined();
    expect(refused(header(108, [0xff, 0xe0, 0, 0, 0, 0, 0, 0]))).toBe(
      'TAR_AMBIGUOUS_NUMBER',
    );
    expect(refused(header(108, [0xff, 0, 0, 0, 0, 0, 0, 0]))).toBe(
      'TAR_AMBIGUOUS_NUMBER',
    );
  });

  it('holds a 12-byte field (mtime) to the same bounds', () => {
    const ff = (count: number) => Array<number>(count).fill(0xff);
    const mtime = (bytes: number[]) => refused(header(136, bytes));
    expect(mtime([0x80, 0, 0, 0, 0, 0x1f, ...ff(6)])).toBeUndefined();
    expect(mtime([0x80, 0, 0, 0, 0, 0x20, 0, 0, 0, 0, 0, 0])).toBe(
      'TAR_AMBIGUOUS_NUMBER',
    );
    expect(mtime([...ff(5), 0xe0, 0, 0, 0, 0, 0, 1])).toBeUndefined();
    expect(mtime([...ff(5), 0xe0, 0, 0, 0, 0, 0, 0])).toBe(
      'TAR_AMBIGUOUS_NUMBER',
    );
  });
});
