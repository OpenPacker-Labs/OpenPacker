/**
 * Cases about meta headers and entry types: a pax header, a global header, a
 * contiguous file, a link name on an entry that is no link.
 */

import { Z, a, b, entry, file, pax } from './blocks.mjs';

const decoy = file('package/decoy.js', 'D');
const global = pax({ comment: 'c' }, 'g');

export const META_CASES = {
  'an extended header with a path, then a file': [
    a,
    pax({ path: 'package/X.js' }),
    decoy,
    Z,
    Z,
  ],
  'an extended header with a path, a global header, then a file': [
    a,
    pax({ path: 'package/X.js' }),
    global,
    decoy,
    Z,
    Z,
  ],
  'an extended header with a size, a global header, then a file': [
    a,
    pax({ size: '1' }),
    global,
    file('package/f.js', 'F'),
    Z,
    Z,
  ],
  'an extended header with a comment, a global header, then a file': [
    a,
    pax({ comment: 'c' }),
    global,
    decoy,
    Z,
    Z,
  ],
  'a contiguous file (typeflag 7)': [
    a,
    entry('package/seven.js', 'S', { type: '7' }),
    Z,
    Z,
  ],
  'a file with a link name': [
    a,
    entry('package/ln.js', 'L', { linkname: 'zzz' }),
    Z,
    Z,
  ],
  'an extended header with a link name, then a file': [
    a,
    pax({ path: 'package/X.js' }, 'x', { linkname: 'zzz' }),
    decoy,
    Z,
    Z,
  ],
  'a directory with a link name': [
    a,
    entry('package/d/', '', { type: '5', linkname: 'zzz' }),
    b,
    Z,
    Z,
  ],
};
