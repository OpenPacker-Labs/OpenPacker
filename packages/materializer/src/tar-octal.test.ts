/**
 * The octal fields pnpm, node-tar and opm must read as one number (ADR 0057
 * §8). `pnpmOctal` is pnpm 10.28.0's `parseOctal`; the expected values below
 * were taken from running pnpm's `parseTarball` and node-tar's `Header` on the
 * same bytes (the archives are in test/tar-oracle, tar-end.test.ts).
 */

import { describe, expect, it } from 'vitest';
import { nodeTarOctal, assertSizeAgrees, pnpmOctal } from './tar-octal.js';

const latin1 = (text: string): Uint8Array => Buffer.from(text, 'latin1');
const size = (text: string): Uint8Array => {
  const header = new Uint8Array(512);
  header.set(latin1(text), 124);
  return header;
};
const refused = (header: Uint8Array): string | undefined => {
  try {
    assertSizeAgrees(header, 0);
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

describe('a size field the readers read alike', () => {
  it.each([
    '00000000004\0',
    '0000000004 \0',
    '00000000004 ',
    ' 0000000004\0',
    '            ',
    '00000000000\0',
  ])('is accepted: %j', (text) => {
    expect(refused(size(text))).toBeUndefined();
  });

  it.each([
    '\0' + '00000001001',
    '\n 0000000004',
    '\r 0000000004',
    '\t 0000000004',
    '\v 0000000004',
    '\f 0000000004',
  ])('is refused when pnpm reads it differently: %j', (text) => {
    expect(refused(size(text))).toBe('TAR_AMBIGUOUS_NUMBER');
  });
});
