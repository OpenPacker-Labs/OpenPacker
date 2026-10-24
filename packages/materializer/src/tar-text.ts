/**
 * The text fields of a header, where node-tar and pnpm cut a string
 * differently (ADR 0058 §8). node-tar's `decString` decodes the field as UTF-8
 * and removes the first NUL and what `.*` matches after it; the pattern has no
 * `s` flag and `.` does not match a line feed, a carriage return, U+2028 or
 * U+2029, so it removes the first NUL and what follows up to the next line
 * terminator and keeps the rest of the field. pnpm's
 * `parseString` and opm's `tarText` cut at the first NUL. A name, a link name
 * or a prefix that holds a byte after its first NUL is therefore read as
 * different strings, and an entry can be dropped ("linkpath forbidden") with
 * its data read as headers.
 */

import { unsafe } from './errors.js';

/**
 * Refuse a name, a link name or a prefix with a byte other than NUL after its
 * first NUL. Real writers zero-pad these fields, so a refusal here also covers
 * junk after the NUL that holds no line terminator and so changes nothing.
 * node-tar reads the prefix only under `ustar\0` `00` magic, 130 bytes of it
 * when byte 475 is zero and 155 otherwise.
 */
export function assertTextAgrees(
  header: Uint8Array,
  at: number,
  ustar: boolean,
): void {
  const fields: Array<[string, number, number]> = [
    ['name', 0, 100],
    ['link name', 157, 100],
  ];
  if (ustar) fields.push(['prefix', 345, header[475] === 0 ? 130 : 155]);
  for (const [label, from, length] of fields) {
    const field = header.subarray(from, from + length);
    const nul = field.indexOf(0);
    if (nul >= 0 && field.subarray(nul).some((byte) => byte !== 0))
      throw unsafe(
        'TAR_AMBIGUOUS_TEXT',
        `the header at offset ${at} has a ${label} with a byte after its first NUL: node-tar keeps what follows a line terminator, pnpm cuts at the NUL`,
      );
  }
}
