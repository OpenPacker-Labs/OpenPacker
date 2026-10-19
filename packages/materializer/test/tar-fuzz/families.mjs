/**
 * The archives the differential fuzz reads (run.mjs), by family. Each family
 * is a generator of `{ label, blocks }`; the blocks are the oracle's own
 * (test/tar-oracle/blocks.mjs), so a header is always written with a checksum
 * that matches its bytes unless a family says otherwise.
 *
 * Exhaustive families visit every case of a fixed list; seeded ones draw from a
 * generator of their own and take `seed` and `count`. What a family varies is
 * what its comment says and nothing more: none of them reaches every archive,
 * and a family that finds no disagreement shows only that it found none.
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
  smuggled,
} from '../tar-oracle/blocks.mjs';

function mulberry32(start) {
  let state = start;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Header bytes, in the order the sweep and the byte runs draw them from. */
const SWEEP_VALUES = [
  0x00, 0x0a, 0x0d, 0x20, 0x30, 0x31, 0x37, 0x38, 0x2b, 0x2d, 0x2f, 0x5c, 0x80,
  0xef, 0xff,
];
const SMUGGLED_BODY = file('package/s0.js', 'SMUGGLED');

/** A file, a file with a ustar prefix, a file whose body is a whole entry, a pax header, each with `edit` applied to its header. */
const BASES = {
  smuggle: (edit) => file('package/o.js', SMUGGLED_BODY, { edit }),
  plain: (edit) => file('package/o.js', 'PLAN', { edit }),
  prefix: (edit) => file('o.js', 'PLAN', { prefix: 'package/sub', edit }),
  pax: (edit) => pax({ path: 'package/px.js' }, 'x', { edit }),
  directory: (edit) => entry('package/d/', '', { type: '5', edit }),
};

/**
 * Every header byte but the checksum's eight, set to each of 15 values (NUL,
 * LF, CR, space, 0, 1, 7, 8, +, -, /, backslash, 0x80, 0xef, 0xff), in four
 * bases (a file that carries an entry as its body, a plain file, a file with a
 * ustar prefix, a pax header): 4 x 504 x 15 = 30,240 archives. The checksum is
 * written after the edit, so each archive is a valid one.
 */
function* byteSweep() {
  for (const name of ['smuggle', 'plain', 'prefix', 'pax'])
    for (let at = 0; at < 512; at += 1) {
      if (at >= 148 && at < 156) continue;
      for (const value of SWEEP_VALUES)
        yield {
          label: `${name}@${at}=${value.toString(16)}`,
          blocks: [
            a,
            BASES[name]((header) => {
              header[at] = value;
            }),
            b,
            Z,
            Z,
          ],
        };
    }
}

/** The fields a header's text and numbers sit in (checksum and typeflag apart). */
const REGIONS = [
  [0, 100],
  [100, 8],
  [108, 8],
  [116, 8],
  [124, 12],
  [136, 12],
  [157, 100],
  [257, 8],
  [265, 32],
  [297, 32],
  [329, 8],
  [337, 8],
  [345, 155],
  [476, 12],
  [488, 12],
];
const ADVERSARIAL = [
  0, 0, 0, 0x20, 0x0a, 0x0d, 0x09, 0x0b, 0x0c, 0x30, 0x31, 0x37, 0x38, 0x78,
  0x80, 0xff, 0xef, 0xbb, 0xbf, 0xe2, 0xa8, 0xc2, 0xa0, 0x2b, 0x2d, 0x2f,
];
/** Ways to write a checksum; the sum is right in all but `bad`. */
const CHECKSUMS = {
  standard: (sum) => `${sum.toString(8).padStart(6, '0')}\0 `,
  swapped: (sum) => `${sum.toString(8).padStart(6, '0')} \0`,
  seven: (sum) => `${sum.toString(8).padStart(7, '0')}\0`,
  eight: (sum) => sum.toString(8).padStart(8, '0'),
  leading: (sum) => ` ${sum.toString(8).padStart(6, '0')}\0`,
  base256: (sum) => {
    const field = Buffer.alloc(8);
    field[0] = 0x80;
    field.writeUIntBE(sum, 2, 6);
    return field;
  },
  bad: (sum) => `${(sum + 3).toString(8).padStart(6, '0')}\0 `,
};

/**
 * One to three runs of one to four bytes, drawn from the bytes above, written
 * into the text or number fields of a base, with the checksum right or spelled
 * one of seven ways. Seeded.
 */
function* fieldBytes(seed, count) {
  const random = mulberry32(seed);
  const pick = (list) => list[Math.floor(random() * list.length)];
  for (let n = 0; n < count; n += 1) {
    const runs = [];
    for (let i = 0, k = 1 + Math.floor(random() * 3); i < k; i += 1) {
      const [from, length] = pick(REGIONS);
      const at = from + (random() < 0.5 ? 0 : Math.floor(random() * length));
      const bytes = Array.from(
        { length: Math.min(1 + Math.floor(random() * 4), from + length - at) },
        () => pick(ADVERSARIAL),
      );
      runs.push([at, bytes]);
    }
    const edit = (header) => {
      for (const [at, bytes] of runs) header.set(bytes, at);
    };
    const base = pick(Object.keys(BASES));
    const spelling = random() < 0.8 ? 'standard' : pick(Object.keys(CHECKSUMS));
    const written = BASES[base](edit);
    if (spelling !== 'standard') {
      const sum = written
        .subarray(0, 512)
        .reduce(
          (total, byte, at) => total + (at >= 148 && at < 156 ? 32 : byte),
          0,
        );
      const field = CHECKSUMS[spelling](sum);
      if (Buffer.isBuffer(field)) field.copy(written, 148);
      else written.write(field, 148, 'latin1');
    }
    yield {
      label: `${base} ${runs.map(([at, bytes]) => `${at}:${bytes.map((x) => x.toString(16)).join('.')}`).join(' ')} ck=${spelling}`,
      blocks: [a, written, random() < 0.5 ? b : Z, Z, Z],
    };
  }
}

/** A pax record whose length prefix is off by `by`. */
const off = (record, by) =>
  `${Number(/^\d+/u.exec(record)[0]) + by}${record.replace(/^\d+/u, '')}`;

/**
 * One to four pax records, then a file, as an `x` or `g` header: paths with a
 * newline, a record smuggled in another's value, a length with a leading zero,
 * off by one or with no final newline, an empty path, a key with a byte order
 * mark, a comment of up to 1,300 bytes (alone, or ending in a character past
 * 0x7f, so the body may pass a block). Seeded.
 */
function* paxRecords(seed, count) {
  const random = mulberry32(seed);
  const pick = (list) => list[Math.floor(random() * list.length)];
  const between = (low, high) => low + Math.floor(random() * (high - low + 1));
  for (let n = 0; n < count; n += 1) {
    const path = `package/p${n}.js`;
    const pool = [
      () => paxRecord('path', path),
      () => paxRecord('path', path.replace('.js', '\n.js')),
      () => paxRecord('path', `${path}\n`),
      () => paxRecord('path', `package/é${n}.js`),
      () => paxRecord('path', ''),
      () => paxRecord('﻿path', path),
      () => paxRecord('size', '1'),
      () => paxRecord('linkpath', 'x'),
      () => paxRecord('comment', 'c'.repeat(between(1, 1300))),
      () => paxRecord('comment', `${'x'.repeat(between(0, 700))}é`),
      () => smuggled('comment', paxRecord('path', `package/s${n}.js`)),
      () => smuggled('comment', paxRecord('size', '1')),
      () => `0${paxRecord('path', path)}`,
      () => paxRecord('path', path).slice(0, -1),
      () => off(paxRecord('path', path), pick([-1, 1])),
    ];
    const records = Array.from({ length: between(1, 4) }, () => pick(pool)());
    yield {
      label: `pax ${records.map((r) => JSON.stringify(r.slice(0, 40))).join(' ')}`,
      blocks: [
        a,
        paxBody(records.join(''), random() < 0.8 ? 'x' : 'g'),
        file(`package/f${n}.js`, `body${n}`),
        Z,
        Z,
      ],
    };
  }
}

/**
 * A path with a two-byte character in it, after a comment that pads the header
 * out, the padding swept so the character's start passes every offset around the
 * places the readers are fed apart: an archive offset of 2,048 and 2,560
 * (multiples of 512, node-tar's units when it is fed a byte at a time), 2,920
 * and 4,380 (multiples of 1,460), 16,384 and 32,768. The header sits after a
 * file's two blocks, so its body starts at offset 1,536.
 */
function* paxCut() {
  for (const cut of [2048, 2560, 2920, 4380, 16384, 32768]) {
    const body = cut - 1536;
    for (let fill = body - 40; fill <= body; fill += 1)
      yield {
        label: `padding of ${fill} bytes, cut at ${cut}`,
        blocks: [
          a,
          paxBody(
            paxRecord('comment', 'c'.repeat(fill)) +
              paxRecord('path', 'package/\u00e9.js'),
          ),
          b,
          Z,
          Z,
        ],
      };
  }
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

/** Every pair and every triple of the 16 headers in META, then files and the end of the archive. */
function* metaOrder() {
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
 * Zero blocks and null blocks (a checksum field of spaces) between three
 * entries and after them, partial blocks of three kinds at 17 lengths, and a
 * pair of files cut every 37 bytes.
 */
function* zeroBlocks() {
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

/** name -> { seeded, archives(seed, count) } */
export const FAMILIES = {
  'byte-sweep': { seeded: false, archives: () => byteSweep() },
  'field-bytes': { seeded: true, archives: fieldBytes },
  'pax-records': { seeded: true, archives: paxRecords },
  'pax-cut': { seeded: false, archives: () => paxCut() },
  'meta-order': { seeded: false, archives: () => metaOrder() },
  'zero-blocks': { seeded: false, archives: () => zeroBlocks() },
};
