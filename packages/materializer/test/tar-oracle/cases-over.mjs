/**
 * Cases opm refuses although npm and pnpm install the same files: the header
 * check cannot tell, without reading as node-tar would, that what it refuses
 * yields no file. A lone zero block that a header node-tar reads follows but
 * which yields no file (TAR_AMBIGUOUS_END), a directory header (which has no
 * file) with a checksum or a number node-tar cannot read, a sized directory
 * whose span holds nothing, a path that an extended header gives a directory,
 * and a prefix that a pax path overrides. ADR 0057 section 8 lists them.
 */

import { Z, a, b, entry, file, invalidBase256, pax } from './blocks.mjs';

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
  'a directory whose checksum field node-tar reads as another number': [
    a,
    entry('package/d/', '', {
      type: '5',
      checksum: (sum) => sum.toString(8).padStart(8, '0'),
    }),
    b,
    Z,
    Z,
  ],
  'a directory whose uid is an invalid base-256 number': [
    a,
    entry('package/d/', '', {
      type: '5',
      edit: (header) => invalidBase256(8).copy(header, 108),
    }),
    b,
    Z,
    Z,
  ],
  'a directory with a size whose span holds only zero blocks': [
    a,
    entry('package/d/', '', { type: '5', size: 1024 }),
    Z,
    Z,
    Z,
    Z,
  ],
  'an extended header with a path, a global header, then a directory': [
    a,
    pax({ path: 'package/X/' }),
    pax({ comment: 'c' }, 'g'),
    entry('package/d/', '', { type: '5' }),
    b,
    Z,
    Z,
  ],
  'a prefix without ustar magic, under an extended header with a path': [
    a,
    pax({ path: 'package/X.js' }),
    file('noprefix.js', 'p', {
      prefix: 'package',
      edit: (header) => header.fill(0, 257, 265),
    }),
    Z,
    Z,
  ],
};
