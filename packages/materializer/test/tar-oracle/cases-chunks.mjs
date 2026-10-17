/**
 * Cases about node-tar's reading of a pax header of more than one block. It
 * decodes the header piece by piece as it is fed (`this[META] += chunk`), so a
 * character cut in two by a piece boundary becomes two U+FFFD and its record is
 * ignored: the same bytes read two ways by how they were fed. A body of one
 * block (512 bytes) is always delivered whole, and pieces are 512 bytes or
 * more, so a cut can fall at any offset of a longer body.
 */

import { Z, file, paxBody, paxRecord } from './blocks.mjs';

const benign = file('package/index.js', 'BENIGN');
const payload = file('package/index.js', 'PAYLOAD');
const accent = '\u00e9';

/** The body of an `x` header that starts `bodyStart` bytes into the archive: a comment, then a path whose first accent straddles the offset `boundary`. */
function straddling(bodyStart, boundary) {
  for (let n = 1; n < 40_000; n += 1) {
    const comment = paxRecord('comment', 'x'.repeat(n));
    const path = paxRecord('path', `package/${accent.repeat(40)}.js`);
    const accentAt =
      bodyStart + comment.length + path.slice(0, path.indexOf(accent)).length;
    if (accentAt === boundary - 1) return comment + path;
  }
  throw new Error(`no body puts an accent across ${boundary}`);
}

/** The archive of a benign file, an `x` header with `body`, and a payload file that header names. */
const named = (body) => [benign, paxBody(body), payload, Z, Z];

export const CHUNK_CASES = {
  'a one-block extended header with non-ASCII bytes': named(
    paxRecord('path', `package/${accent}${accent}.js`),
  ),
  'a longer extended header with ASCII bytes only': named(
    paxRecord('path', 'package/X.js') + paxRecord('comment', 'x'.repeat(700)),
  ),
  'a longer extended header with non-ASCII bytes no cut can split': named(
    paxRecord('path', `package/${accent}${accent}.js`) +
      paxRecord('comment', 'x'.repeat(700)),
  ),
  'an extended header with a character across offset 512 of its body': named(
    straddling(1536, 2048),
  ),
  'an extended header with a character across offset 16,384': named(
    straddling(1536, 16_384),
  ),
};
