/**
 * Cases about how each reader turns the bytes of a header field into a string:
 * a leading BOM (TextDecoder strips it, node-tar and pnpm keep it), and a NUL
 * followed by a line terminator in a name, a link name or a prefix (node-tar's
 * `/\0.*\/` stops at the terminator and keeps the rest; pnpm and opm cut at the
 * NUL).
 */

import { Z, a, b, file, pax } from './blocks.mjs';

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
};
