/**
 * Cases about numeric fields only node-tar reads: uid, gid, mtime, and under
 * `ustar\0` `00` magic devmajor, devminor and (byte 475 zero) atime and ctime.
 * A base-256 number it cannot decode makes it drop the entry. And the octal
 * size and checksum fields all three read, which pnpm cuts differently (a NUL
 * before the digits; a control whitespace before a space).
 */

import { Z, a, b, entry, file, invalidBase256 } from './blocks.mjs';

/** A header edit that writes `text` (Latin-1) over the size field. */
const sizeField = (text) => (header) => {
  header.fill(0, 124, 136);
  Buffer.from(text, 'latin1').copy(header, 124);
};
/** A file of `AAAA` whose size field is spelled `text`. */
const sized = (text) =>
  entry('package/s.js', 'AAAA', { edit: sizeField(text) });

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
  'a size field that is a NUL, then digits': [
    file('package/index.js', 'BENIGN'),
    entry('package/a.js', '', { edit: sizeField('\0' + '00000001001') }),
    file('package/evil.js', 'EVIL'),
    file('package/tail.js', 'T'),
    Z,
    Z,
  ],
  'a size field that is a line feed, a space and digits': [
    a,
    sized('\n 0000000004'),
    b,
    Z,
    Z,
  ],
  'a size field that is a tab, a space and digits': [
    a,
    sized('\t 0000000004'),
    b,
    Z,
    Z,
  ],
  'a checksum field that is a line feed, a space and digits': [
    a,
    entry('package/c.js', 'AAAA', {
      checksum: (sum) =>
        Buffer.from(`\n ${sum.toString(8).padStart(5, '0')}\0`, 'latin1'),
    }),
    b,
    Z,
    Z,
  ],
  'size fields spelled as writers spell them': [
    a,
    sized('0000000004 \0'),
    entry('package/t.js', 'AAAA', { edit: sizeField('00000000004 ') }),
    entry('package/u.js', 'AAAA', { edit: sizeField(' 0000000004\0') }),
    b,
    Z,
    Z,
  ],
};
