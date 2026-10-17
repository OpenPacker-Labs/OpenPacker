/**
 * Cases about how each reader turns the bytes of a header field into a string:
 * a leading BOM (TextDecoder strips it, node-tar and pnpm keep it), and a NUL
 * followed by a line terminator in a name, a link name or a prefix (node-tar's
 * `/\0.*\/` stops at the terminator and keeps the rest; pnpm and opm cut at the
 * NUL).
 */

import { Z, a, b, entry, file, pax } from './blocks.mjs';

/** `head`, a NUL, `after`, filled with x to `length` bytes. */
const field = (head, after, length) => {
  const bytes = Buffer.alloc(length, 0x78);
  Buffer.from(head).copy(bytes, 0);
  bytes[head.length] = 0;
  Buffer.from(after).copy(bytes, head.length + 1);
  return bytes;
};
/** A header edit that writes `bytes` at `offset` over a cleared `length`. */
const write = (offset, length, bytes) => (header) => {
  header.fill(0, offset, offset + length);
  bytes.copy(header, offset);
};
/** A header, then one block of data, of a file named `package/index.js` holding PAYLOAD. */
const forged = file('package/index.js', 'PAYLOAD');
/** A link name of NUL, a line feed and NULs: node-tar reads "\\n", a name that is no link's. */
const terminated = Buffer.alloc(100);
terminated[1] = 0x0a;

export const TEXT_CASES = {
  'a pax key that starts with a BOM': [
    a,
    pax({ '﻿path': 'package/X.js' }),
    b,
    Z,
    Z,
  ],
  'a prefix that is a BOM': [
    file('package/p.js', 'p', { prefix: '﻿' }),
    b,
    Z,
    Z,
  ],
  'a name with a NUL and a line feed in it': [
    entry('x', 'DATA', { edit: write(0, 100, field('package/ab', '\n', 100)) }),
    file('package/z.js', 'z'),
    Z,
    Z,
  ],
  'a name with a NUL and a carriage return in it': [
    entry('x', 'DATA', { edit: write(0, 100, field('package/ab', '\r', 100)) }),
    file('package/z.js', 'z'),
    Z,
    Z,
  ],
  'a name with a NUL and a U+2028 in it': [
    entry('x', 'DATA', {
      edit: write(0, 100, field('package/ab', '\u2028', 100)),
    }),
    file('package/z.js', 'z'),
    Z,
    Z,
  ],
  'a prefix with a NUL and a line feed in it': [
    entry('ab.js', 'DATA', {
      edit: write(345, 130, field('package', '\n/', 130)),
    }),
    file('package/z.js', 'z'),
    Z,
    Z,
  ],
  'a link name of a NUL and a line feed, on a file': [
    entry('package/a.js', 'AAAA', { edit: write(157, 100, terminated) }),
    file('package/z.js', 'z'),
    Z,
    Z,
  ],
  'a link name of a NUL and a line feed hides a forged entry': [
    file('package/index.js', 'BENIGN'),
    entry('package/a.js', '', {
      size: 1024,
      edit: write(157, 100, terminated),
    }),
    forged,
    file('package/tail.js', 'T'),
    Z,
    Z,
  ],
  'a name with data after a NUL and no line terminator': [
    entry('x', 'DATA', { edit: write(0, 100, field('package/ab', 'cd', 100)) }),
    file('package/z.js', 'z'),
    Z,
    Z,
  ],
  'a header with a prefix, an atime and a ctime': [
    file('p.js', 'p', {
      prefix: 'package',
      edit: (header) => {
        header.write('00000000001\0', 476);
        header.write('00000000001\0', 488);
      },
    }),
    b,
    Z,
    Z,
  ],
};
