/**
 * The octal fields pnpm, node-tar and opm must read as one number (ADR 0058
 * §8). `pnpmOctal` is pnpm 10.28.0's `parseOctal`; the expected values below
 * were taken from running pnpm's `parseTarball` and node-tar's `Header` on the
 * same bytes (the archives are in test/tar-oracle, tar-end.test.ts).
 */

import { describe, expect, it } from 'vitest';
import { assertOctalAgrees, nodeTarOctal, pnpmOctal } from './tar-octal.js';

const latin1 = (text: string): Uint8Array => Buffer.from(text, 'latin1');
/** A header with `text` written at the start of its size or mode field. */
const header = (name: 'size' | 'mode', text: string): Uint8Array => {
  const bytes = new Uint8Array(512);
  bytes.set(latin1(text), name === 'size' ? 124 : 100);
  return bytes;
};
const refused = (
  bytes: Uint8Array,
  name: 'size' | 'mode',
): string | undefined => {
  try {
    assertOctalAgrees(bytes, 0, name);
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
};

describe('pnpm and node-tar octal readers', () => {
  it.each([
    ['00000000004\0', 4, 4],
    ['0000000004 \0', 4, 4],
    ['00000000004 ', 4, 4],
    [' 0000000004\0', 4, 4],
    ['\0' + '00000001001', 0o1001, null],
    ['\n 0000000004', Number.NaN, 4],
    ['            ', 0, null],
    ['\0'.repeat(12), 0, null],
  ] as const)('read %j as pnpm %s and node-tar %s', (text, pnpm, nodeTar) => {
    const field = latin1(text);
    expect(pnpmOctal(field)).toEqual(pnpm);
    expect(nodeTarOctal(field)).toEqual(nodeTar);
  });
});

describe.each(['size', 'mode'] as const)('a %s field', (name) => {
  const width = name === 'size' ? 12 : 8;
  const digits = (text: string) => text.padEnd(width, '\0').slice(0, width);

  it.each(['4\0', '4 \0', ' 4\0', '0004\0', ' 004 ', '00000004', '', ' ', '0'])(
    'the readers read alike is accepted: %j',
    (text) => {
      expect(refused(header(name, digits(text)), name)).toBeUndefined();
    },
  );

  it.each([
    ['a NUL, then digits', '\0' + '04'],
    ['a line feed, a space and digits', '\n 04'],
    ['a carriage return, a space and digits', '\r 04'],
    ['a tab, a space and digits', '\t 04'],
    ['a vertical tab, a space and digits', '\v 04'],
    ['a form feed, a space and digits', '\f 04'],
  ])('with %s is refused when pnpm reads it differently', (_, text) => {
    expect(refused(header(name, digits(text)), name)).toBe(
      'TAR_AMBIGUOUS_NUMBER',
    );
  });
});

describe('a mode field, which decides whether a file is executable', () => {
  it('reads a NUL then digits as 0o755 in pnpm and as 0 in node-tar and opm', () => {
    const field = latin1('\0' + '000755' + '\0');
    expect(pnpmOctal(field) & 0o111).not.toBe(0);
    expect(nodeTarOctal(field)).toBeNull();
    expect(refused(header('mode', '\0' + '000755' + '\0'), 'mode')).toBe(
      'TAR_AMBIGUOUS_NUMBER',
    );
  });

  it('reads a line feed, a space and digits as 0o755 in node-tar and opm and as no mode in pnpm', () => {
    const field = latin1('\n 00755\0');
    expect(pnpmOctal(field) & 0o111).toBe(0);
    expect(nodeTarOctal(field)).toBe(0o755);
    expect(refused(header('mode', '\n 00755\0'), 'mode')).toBe(
      'TAR_AMBIGUOUS_NUMBER',
    );
  });
});
