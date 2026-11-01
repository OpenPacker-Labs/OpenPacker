/**
 * Which text fields of a header must hold only NULs after their first NUL
 * (ADR 0058 §8), and how long node-tar reads the prefix. The archives that show
 * the readers part over it are in test/tar-oracle (tar-end.test.ts).
 */

import { describe, expect, it } from 'vitest';
import { assertTextAgrees } from './tar-text.js';

const refused = (header: Uint8Array, ustar = true): string | undefined => {
  try {
    assertTextAgrees(header, 0, ustar);
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
};
const header = (offset: number, bytes: number[]): Uint8Array => {
  const block = new Uint8Array(512);
  block.set(bytes, offset);
  return block;
};

describe('a text field with a byte after its first NUL', () => {
  it('is refused in a name and in a link name, whatever the byte', () => {
    for (const offset of [0, 157]) {
      expect(refused(header(offset, [0x61, 0, 0x0a, 0]))).toBe(
        'TAR_AMBIGUOUS_TEXT',
      );
      expect(refused(header(offset, [0x61, 0, 0x62]))).toBe(
        'TAR_AMBIGUOUS_TEXT',
      );
      expect(refused(header(offset, [0, 0x0a]))).toBe('TAR_AMBIGUOUS_TEXT');
    }
  });

  it('is accepted when only NULs follow, or the field is full', () => {
    expect(refused(header(0, [0x61, 0x62]))).toBeUndefined();
    expect(refused(header(0, Array(100).fill(0x61)))).toBeUndefined();
    expect(refused(header(157, Array(100).fill(0x61)))).toBeUndefined();
    expect(refused(new Uint8Array(512))).toBeUndefined();
  });

  it('is read in the prefix for 130 bytes when byte 475 is zero, for 155 otherwise, and only under ustar magic', () => {
    expect(refused(header(345, [0x61, 0, 0x0a]))).toBe('TAR_AMBIGUOUS_TEXT');
    // atime and ctime sit after the 130-byte prefix when byte 475 is zero
    expect(refused(header(476, [0x30, 0x31]))).toBeUndefined();
    expect(refused(header(488, [0x30, 0x31]))).toBeUndefined();
    const long = header(345, [0x61, 0]);
    long[475] = 0x78;
    long[476] = 0x31;
    expect(refused(long)).toBe('TAR_AMBIGUOUS_TEXT');
    expect(refused(header(345, [0x61, 0, 0x0a]), false)).toBeUndefined();
  });

  it('is refused in the last byte of the 130-byte prefix', () => {
    expect(refused(header(345 + 128, [0, 0x41]))).toBe('TAR_AMBIGUOUS_TEXT');
  });
});
