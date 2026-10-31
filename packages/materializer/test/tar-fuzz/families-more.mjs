/**
 * The fuzz families about where node-tar is fed apart (`pax-cut`), the order of
 * headers (`meta-order`) and the end of an archive (`zero-blocks`); families.mjs
 * has the others and the rules for seeds.
 */

import {
  N,
  Z,
  a,
  b,
  c,
  entry,
  file,
  garbage,
  pax,
  paxBody,
  paxRecord,
} from '../tar-oracle/blocks.mjs';
import { mulberry32 } from './random.mjs';

/** Characters of two, three and four bytes in UTF-8. */
const CHARACTERS = ['\u00e9', '\u00fc', '\u00df', '\u4e2d', '\u{1f600}'];

/** The archive of a file, an `x` header whose body is a comment of `fill` bytes and then a path holding `character`, and another file. */
const cutAt = (fill, character) => [
  a,
  paxBody(
    paxRecord('comment', 'c'.repeat(fill)) +
      paxRecord('path', `package/${character}.js`),
  ),
  b,
  Z,
  Z,
];

/**
 * Without a seed: a path with é in it, after a comment that pads the header
 * out, the padding swept so the character's start passes every offset around
 * the places the readers are fed apart: an archive offset of 2,048 and 2,560
 * (multiples of 512, node-tar's units when it is fed a byte at a time), 2,920
 * and 4,380 (multiples of 1,460), 16,384 and 32,768 (246 archives). The header
 * sits after a file's two blocks, so its body starts at offset 1,536. With a
 * seed, `count` archives with a cut, a padding within 40 bytes of it and a
 * character of two, three or four bytes drawn at random.
 */
export function* paxCut(seed, count = 2000) {
  const cuts = [2048, 2560, 2920, 4380, 16384, 32768];
  if (seed !== undefined) {
    const random = mulberry32(seed);
    for (let n = 0; n < count; n += 1) {
      const cut = cuts[Math.floor(random() * cuts.length)];
      const fill = cut - 1536 - Math.floor(random() * 41);
      const character = CHARACTERS[Math.floor(random() * CHARACTERS.length)];
      yield {
        label: `${JSON.stringify(character)} after ${fill} bytes, cut at ${cut}`,
        blocks: cutAt(fill, character),
      };
    }
    return;
  }
  for (const cut of cuts)
    for (let fill = cut - 1536 - 40; fill <= cut - 1536; fill += 1)
      yield {
        label: `padding of ${fill} bytes, cut at ${cut}`,
        blocks: cutAt(fill, '\u00e9'),
      };
}

const long = (type, name) => entry('././@LongLink', `${name}\0`, { type });
/** Headers that change what the next one means, and files, to put in every order. */
const META = [
  a,
  b,
  pax({ path: 'package/X.js' }),
  pax({ comment: 'c' }, 'g'),
  pax({ path: 'package/zz.js' }, 'g'),
  long('L', 'package/L.js'),
  long('K', 'package/K.js'),
  entry('package/dd/', '', { type: '5' }),
  entry('package/ds/', '', { type: '5', size: 512 }),
  pax({ size: '1' }),
  pax({ path: 'package/Y.js', size: '1' }),
  pax({ size: '2' }),
  pax({ linkpath: 'q' }),
  pax({ path: 'p.js' }),
  pax({ path: 'package/a/b/c.js' }),
  pax({ path: 'package//d.js' }),
];

/**
 * Without a seed, every pair and every triple of the 16 headers in META, then
 * files and the end of the archive (4,864 archives); with one, `count` runs of
 * two to five of them drawn at random, then a file.
 */
export function* metaOrder(seed, count = 2000) {
  if (seed !== undefined) {
    const random = mulberry32(seed);
    for (let n = 0; n < count; n += 1) {
      const picks = Array.from({ length: 2 + Math.floor(random() * 4) }, () =>
        Math.floor(random() * META.length),
      );
      yield {
        label: picks.join(','),
        blocks: [...picks.map((at) => META[at]), c, Z, Z],
      };
    }
    return;
  }
  for (const first of META.keys())
    for (const second of META.keys()) {
      const pair = [META[first], META[second]];
      yield { label: `${first},${second}`, blocks: [...pair, Z, Z] };
      for (const tail of [c, a])
        yield {
          label: `${first},${second},file`,
          blocks: [...pair, tail, Z, Z],
        };
      for (const third of META.keys())
        yield {
          label: `${first},${second},${third}`,
          blocks: [...pair, META[third], c, Z, Z],
        };
    }
}

/** A header cut to its first `length` bytes, or `length` bytes of 0x41 or 0. */
const partial = (kind, length) =>
  kind === 'zero'
    ? Buffer.alloc(length)
    : kind === 'junk'
      ? Buffer.alloc(length, 0x41)
      : file('package/p.js', '').subarray(0, length);

/**
 * Without a seed: zero blocks and null blocks (a checksum field of spaces)
 * between three entries and after them, partial blocks of three kinds at 17
 * lengths, and a pair of files cut every 37 bytes (1,183 archives). With one,
 * `count` runs of one to six entries, zero, null and junk blocks drawn at
 * random, ended by a partial block of a drawn kind and length or by nothing.
 */
export function* zeroBlocks(seed, count = 2000) {
  if (seed !== undefined) {
    const random = mulberry32(seed);
    const units = [a, b, c, Z, Z, N, garbage];
    for (let n = 0; n < count; n += 1) {
      const blocks = Array.from(
        { length: 1 + Math.floor(random() * 6) },
        () => units[Math.floor(random() * units.length)],
      );
      if (random() < 0.5)
        blocks.push(
          partial(
            ['zero', 'junk', 'header'][Math.floor(random() * 3)],
            1 + Math.floor(random() * 511),
          ),
        );
      yield { label: `random ${n}`, blocks };
    }
    return;
  }
  const entries = [a, b, c];
  const tails = [[], [Z], [Z, Z], [N], [N, N], [Z, N], [N, Z], [garbage]];
  const inserts = [[Z], [Z, Z], [N], [Z, N], [N, Z]];
  for (let mask = 0; mask < 16; mask += 1)
    for (const insert of inserts)
      for (const [t, tail] of tails.entries()) {
        const blocks = [];
        for (let i = 0; i < 4; i += 1) {
          if (mask & (1 << i)) blocks.push(...insert);
          if (i < 3) blocks.push(entries[i]);
        }
        yield {
          label: `zeros ${mask} ${insert.length} tail ${t}`,
          blocks: [...blocks, ...tail],
        };
      }
  const lengths = [
    1, 7, 100, 147, 148, 149, 155, 156, 157, 255, 256, 257, 264, 265, 345, 500,
    511,
  ];
  for (const head of [[], [Z], [Z, Z]])
    for (const kind of ['zero', 'junk', 'header'])
      for (const length of lengths) {
        const part = partial(kind, length);
        yield {
          label: `partial ${kind} ${length}`,
          blocks: [a, b, ...head, part],
        };
        yield {
          label: `partial ${kind} ${length} after Z`,
          blocks: [a, b, ...head, Z, part],
        };
        yield {
          label: `partial ${kind} ${length} before c`,
          blocks: [a, b, Z, ...head, c, part],
        };
      }
  const whole = Buffer.concat([a, b, Z, Z]);
  for (let cut = 0; cut <= whole.length; cut += 37)
    yield { label: `cut at ${cut}`, blocks: [whole.subarray(0, cut)] };
}
