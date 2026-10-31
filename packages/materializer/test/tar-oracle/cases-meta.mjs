/**
 * Cases about meta headers and entry types: a pax header, a global header, a
 * contiguous file, a link name on an entry that is no link.
 */

import {
  Z,
  a,
  b,
  entry,
  file,
  pax,
  paxBody,
  paxRecord,
  smuggled,
} from './blocks.mjs';

const decoy = file('package/decoy.js', 'D');
const global = pax({ comment: 'c' }, 'g');

/**
 * One pax record whose key starts with a line feed and whose value is `inner`,
 * a whole record: node-tar splits the header at the line feed and reads `inner`
 * on its own; pnpm and opm read one record by its length.
 */
function startsWithLineFeed(inner) {
  const text = ` \n${inner}`;
  const bytes = Buffer.byteLength(text);
  let length = bytes + String(bytes).length;
  length = bytes + String(length).length;
  return `${length}${text}`;
}

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
  'a path record with a newline in its value': [
    a,
    paxBody(paxRecord('path', 'package/n\nl.js')),
    b,
    Z,
    Z,
  ],
  'a path record smuggled in a comment record': [
    a,
    paxBody(smuggled('comment', paxRecord('path', 'package/evil.js'))),
    b,
    Z,
    Z,
  ],
  'a size record smuggled in a comment record': [
    a,
    paxBody(smuggled('comment', paxRecord('size', '1'))),
    file('package/f.js', 'abcde'),
    Z,
    Z,
  ],
  'a path record that ends in a newline': [
    a,
    paxBody(paxRecord('path', 'package/X.js\n')),
    decoy,
    Z,
    Z,
  ],
  'a benign file, then the same name behind a path with a newline': [
    file('package/index.js', 'BENIGN'),
    paxBody(paxRecord('path', 'package/z\nz.js')),
    file('package/index.js', 'PAYLOAD'),
    Z,
    Z,
  ],
  'a newline in the second of two records': [
    a,
    paxBody(paxRecord('comment', 'c') + paxRecord('path', 'package/n\nl.js')),
    b,
    Z,
    Z,
  ],
  'a pax length with a leading zero': [
    a,
    paxBody('0023 path=package/X.js\n'),
    decoy,
    Z,
    Z,
  ],
  'a pax record with no final newline': [
    a,
    paxBody('21 path=package/X.jsY'),
    decoy,
    Z,
    Z,
  ],
  'an extended header with a path, a directory with a link name, then a file': [
    a,
    pax({ path: 'package/X.js' }),
    entry('package/d/', '', { type: '5', linkname: 'zzz' }),
    decoy,
    Z,
    Z,
  ],
  'an extended header with a path, a directory, then a file': [
    a,
    pax({ path: 'package/X.js' }),
    entry('package/d/', '', { type: '5' }),
    decoy,
    Z,
    Z,
  ],
  'a one-character link name on a file hides a forged entry': [
    file('package/index.js', 'BENIGN'),
    entry('package/a.js', file('package/index.js', 'PAYLOAD'), {
      linkname: 'x',
    }),
    Z,
    Z,
  ],
  'a pax record whose key starts with a line feed': [
    a,
    paxBody(startsWithLineFeed(paxRecord('path', 'package/X.js'))),
    b,
    Z,
    Z,
  ],
  'a linkpath record that is a number, then a file': [
    a,
    pax({ linkpath: '1234' }),
    b,
    Z,
    Z,
  ],
  'a linkpath record that leaves the directory, then a file': [
    a,
    pax({ linkpath: '..' }),
    b,
    Z,
    Z,
  ],
};
