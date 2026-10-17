/**
 * Cases about numeric fields only node-tar reads: uid, gid, mtime, and under
 * `ustar\0` `00` magic devmajor, devminor and (byte 475 zero) atime and ctime.
 * A base-256 number it cannot decode makes it drop the entry.
 */

import { Z, a, file, invalidBase256 } from './blocks.mjs';

const invalid = (name, offset, length) => [
  a,
  file(`package/${name}.js`, name, {
    edit: (header) => invalidBase256(length).copy(header, offset),
  }),
  Z,
  Z,
];

export const NUMBER_CASES = {
  'a uid that is an invalid base-256 number': invalid('uid', 108, 8),
  'a gid that is an invalid base-256 number': invalid('gid', 116, 8),
  'an mtime that is an invalid base-256 number': invalid('mtime', 136, 12),
  'a devmajor that is an invalid base-256 number': invalid('devmajor', 329, 8),
  'a devminor that is an invalid base-256 number': invalid('devminor', 337, 8),
  'an atime that is an invalid base-256 number': invalid('atime', 476, 12),
  'a ctime that is an invalid base-256 number': invalid('ctime', 488, 12),
  'a uid that is a base-256 number too large to be safe': [
    a,
    file('package/big.js', 'big', {
      edit: (header) =>
        Buffer.from([0x80, 255, 255, 255, 255, 255, 255, 255]).copy(
          header,
          108,
        ),
    }),
    Z,
    Z,
  ],
  'a uid that is a valid base-256 number': [
    a,
    file('package/uid.js', 'uid', {
      edit: (header) =>
        Buffer.from([0x80, 0, 0, 0, 0, 0, 0, 5]).copy(header, 108),
    }),
    Z,
    Z,
  ],
  'an mtime that is a valid negative base-256 number': [
    a,
    file('package/mtime.js', 'mtime', {
      edit: (header) => Buffer.alloc(12, 0xff).copy(header, 136),
    }),
    Z,
    Z,
  ],
  'a devmajor that is invalid, in a header without ustar magic': [
    a,
    file('package/plain.js', 'plain', {
      edit: (header) => {
        header.fill(0, 257, 265);
        invalidBase256(8).copy(header, 329);
      },
    }),
    Z,
    Z,
  ],
};
