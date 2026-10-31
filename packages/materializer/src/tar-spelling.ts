/**
 * The second layer of the npm reader agreement (ADR 0058 §8): the spelling of
 * a header's numeric and magic fields, as a list of what is accepted rather
 * than of what is known to break. node-tar (`decSmallNumber`, `decNumber`), pnpm
 * (`parseOctal`) and opm (`tarNumber`) cut and decode these fields three ways,
 * and five rounds of review each found a new spelling they decode differently.
 * The classes below are the ones real writers produce (a histogram of 98,074
 * headers in 3,386 registry archives: two to four spellings per field), and
 * every spelling in them is read as one number by all three; any other spelling
 * is refused here, after the targeted checks in tar-agreement.ts have run, so a
 * header those checks refuse keeps their code.
 *
 * The layer reads single fields only. What depends on more than one header (the
 * end of the archive, a pending extended header, a dropped entry, how the input
 * was cut into pieces) stays a rule in tar-agreement.ts.
 */

import { unsafe } from './errors.js';

const latin1 = (field: Uint8Array): string =>
  Buffer.from(field).toString('latin1');

/** Octal digits, led by spaces at most, ended by at most one space and then NULs. */
const OCTAL = /^ *[0-7]+ ?\0*$/u;
/** The checksum as ustar writes it: six digits, a NUL, a space. */
const CLASSIC_CHECKSUM = /^[0-7]{6}\0 $/u;
/** `ustar\0` `00` (POSIX), `ustar  \0` (GNU), or none at all (V7). */
const MAGICS = new Set(['ustar\u000000', 'ustar  \u0000', '\u0000'.repeat(8)]);

const allNul = (field: Uint8Array): boolean =>
  field.every((byte) => byte === 0);

/** A base-256 number as node-tar writes it: a first byte of 0x80 (positive) or 0xff (negative). */
const base256 = (field: Uint8Array): boolean =>
  field[0] === 0x80 || field[0] === 0xff;

/**
 * A number field: octal digits as above, or all NUL (no number, read as 0 by
 * every reader), or, where node-tar writes one, base-256. The mode and the size
 * take no base-256 (`tarNumber` refuses it as ADAPTER_REQUIRED).
 */
const isNumber = (field: Uint8Array, wide: boolean): boolean =>
  OCTAL.test(latin1(field)) || allNul(field) || (wide && base256(field));

/** The fields read as numbers: name, offset, length, and whether base-256 is a spelling of it. */
const NUMBERS: Array<[string, number, number, boolean]> = [
  ['mode', 100, 8, false],
  ['uid', 108, 8, true],
  ['gid', 116, 8, true],
  ['size', 124, 12, false],
  ['mtime', 136, 12, true],
];
/** Read by node-tar only under `ustar\0` `00` magic. */
const USTAR_NUMBERS: Array<[string, number, number, boolean]> = [
  ['devmajor', 329, 8, true],
  ['devminor', 337, 8, true],
];
/** Read by node-tar only under `ustar\0` `00` magic when byte 475 is zero. */
const TIMES: Array<[string, number, number, boolean]> = [
  ['atime', 476, 12, true],
  ['ctime', 488, 12, true],
];

/** Refuse a header whose numeric or magic fields are spelled outside the classes real writers use. */
export function assertSpellingKnown(
  header: Uint8Array,
  at: number,
  ustar: boolean,
): void {
  const refuse = (label: string): never => {
    throw unsafe(
      'TAR_AMBIGUOUS_SPELLING',
      `the header at offset ${at} spells its ${label} in a way no known writer does, so npm, pnpm and opm may read it differently`,
    );
  };
  const checksum = header.subarray(148, 156);
  if (!CLASSIC_CHECKSUM.test(latin1(checksum)) && !OCTAL.test(latin1(checksum)))
    refuse('checksum');
  const numbers = [
    ...NUMBERS,
    ...(ustar ? USTAR_NUMBERS : []),
    ...(ustar && header[475] === 0 ? TIMES : []),
  ];
  for (const [label, from, length, wide] of numbers)
    if (!isNumber(header.subarray(from, from + length), wide)) refuse(label);
  if (!MAGICS.has(latin1(header.subarray(257, 265)))) refuse('magic');
  if (!allNul(header.subarray(500, 512))) refuse('last 12 bytes');
}
