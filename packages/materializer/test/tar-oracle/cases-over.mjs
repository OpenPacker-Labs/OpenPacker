/**
 * Cases where node-tar reads a header after a lone zero block, pnpm has ended,
 * and the file sets still agree because the header yields no file. opm cannot
 * tell these from one that does without reading what node-tar would, so it
 * refuses them (TAR_AMBIGUOUS_END): the over-refusals ADR 0057 \u00a78 lists.
 */

import { Z, a, entry, file } from './blocks.mjs';

/** A checksum field node-tar reads over 12 bytes as a base-256 number it cannot use. */
const base256 = (sum) => {
  const field = Buffer.alloc(8);
  field[0] = 0x80;
  field.writeUIntBE(sum, 2, 6);
  return field;
};

export const OVER_CASES = {
  'a lone zero block, then a header with no path': [a, Z, file('', ''), Z, Z],
  'a lone zero block, then a directory': [
    a,
    Z,
    entry('package/d/', '', { type: '5' }),
    Z,
    Z,
  ],
  'a lone zero block, then a base-256 checksum': [
    a,
    Z,
    file('package/b.js', 'B', { checksum: base256 }),
    Z,
    Z,
  ],
};
