/**
 * Cases about where the archive ends, its checksum, its prefix and its name:
 * what npm's node-tar 6.2.1 and pnpm 10.28.0's `parseTarball` install from
 * each, and so what opm must refuse or extract.
 */

import { N, Z, a, b, c, file, garbage } from './blocks.mjs';

export const END_CASES = {
  'two zero blocks end it': [a, Z, Z],
  'a whole record of zeros ends it': [a, Buffer.alloc(9216)],
  'the end of the data ends it': [a],
  'one zero block at the end of the data ends it': [a, Z],
  'nothing after two zero blocks is read': [a, Z, Z, b, Z, Z],
  'a lone zero block between entries': [a, Z, b, Z, Z],
  'lone zero blocks between three entries': [a, Z, b, Z, c, Z, Z],
  'a lone zero block before the first entry': [Z, a, Z, Z],
  'a lone zero block, then a block that is not a header': [a, Z, garbage, Z, Z],
  'a lone zero block, a block that is not a header, then an entry': [
    a,
    Z,
    garbage,
    b,
    Z,
    Z,
  ],
  'a node-tar null block between entries': [a, N, b, Z, Z],
  'a lone zero block, then a node-tar null block': [a, Z, N, b],
  'a node-tar null block, then a zero block': [a, N, Z, b],
  'an 8-digit checksum with no terminator, typeflag 0 after it': [
    a,
    file('package/eight.js', 'e', {
      checksum: (sum) => sum.toString(8).padStart(8, '0'),
    }),
    Z,
    Z,
  ],
  'an 8-digit checksum with no terminator, typeflag NUL after it': [
    a,
    file('package/ok.js', 'k', {
      edit: (header) => header.fill(0, 156, 157),
      checksum: (sum) => sum.toString(8).padStart(8, '0'),
    }),
    Z,
    Z,
  ],
  'a prefix in a header without ustar magic': [
    a,
    file('noprefix.js', 'p', {
      prefix: 'package',
      edit: (header) => header.fill(0, 257, 265),
    }),
    Z,
    Z,
  ],
  'a prefix in a GNU header (magic "ustar  ")': [
    a,
    file('gnu.js', 'g', {
      prefix: 'package',
      edit: (header) => header.write('ustar  \0', 257),
    }),
    Z,
    Z,
  ],
  'a long path split into a ustar prefix': [
    a,
    file('file.js', 'l', { prefix: `package/${'d'.repeat(60)}` }),
    Z,
    Z,
  ],
  'a header whose name starts with NUL, its path in the prefix': [
    a,
    file('', 'h', { prefix: 'package/hidden.js' }),
    Z,
    Z,
  ],
};
