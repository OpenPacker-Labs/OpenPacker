/**
 * The archives the differential fuzz reads (run.mjs), by family. Each family
 * is a generator of `{ label, blocks }`; the blocks are the oracle's own
 * (test/tar-oracle/blocks.mjs), so a header is always written with a checksum
 * that matches its bytes unless a family says otherwise.
 *
 * Every family takes a seed and a count. Without a seed, `byte-sweep`,
 * `pax-cut`, `meta-order` and `zero-blocks` visit every case of a fixed list
 * (the count is ignored) and the other two use seed 1; with one, each draws
 * `count` archives (or, for the sweep and the cuts, the same positions with
 * drawn values) from a generator of its own. What a family varies is what its
 * comment says and nothing more: none of them reaches every archive, and a
 * family that finds no disagreement shows only that it found none. The last
 * three families are in families-more.mjs.
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
} from '../tar-oracle/blocks.mjs';
import { metaOrder, paxCut, zeroBlocks } from './families-more.mjs';
import { mulberry32 } from './random.mjs';

/** Header bytes, in the order the sweep and the byte runs draw them from. */
const SWEEP_VALUES = [
  0x00, 0x0a, 0x0d, 0x20, 0x30, 0x31, 0x37, 0x38, 0x2b, 0x2d, 0x2f, 0x5c, 0x80,
  0xef, 0xff,
];
const SMUGGLED_BODY = file('package/s0.js', 'SMUGGLED');

/**
 * A file, an executable file, a file with a ustar prefix, a file whose body is
 * a whole entry, a pax header and a directory, each with `edit` applied to its
 * header.
 */
const BASES = {
  smuggle: (edit) => file('package/o.js', SMUGGLED_BODY, { edit }),
  plain: (edit) => file('package/o.js', 'PLAN', { edit }),
  executable: (edit) =>
    file('package/run.js', 'RUN', {
      edit: (header) => {
        header.write('0000755\0', 100, 'latin1');
        edit(header);
      },
    }),
  prefix: (edit) => file('o.js', 'PLAN', { prefix: 'package/sub', edit }),
  pax: (edit) => pax({ path: 'package/px.js' }, 'x', { edit }),
  directory: (edit) => entry('package/d/', '', { type: '5', edit }),
};

/**
 * Without a seed, every header byte but the checksum's eight set to each of 15
 * values (NUL, LF, CR, space, 0, 1, 7, 8, +, -, /, backslash, 0x80, 0xef,
 * 0xff), in five bases (a file that carries an entry as its body, a plain
 * file, an executable file, a file with a ustar prefix, a pax header): 5 x 504
 * x 15 = 37,800 archives. With a seed, `count` archives with a base, a
 * position and a byte drawn at random. The checksum is written after the
 * edit, so each archive is a valid one.
 */
function* byteSweep(seed, count = 2000) {
  const names = ['smuggle', 'plain', 'executable', 'prefix', 'pax'];
  const one = (name, at, value) => ({
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
  });
  if (seed !== undefined) {
    const random = mulberry32(seed);
    for (let n = 0; n < count; n += 1) {
      let at = Math.floor(random() * 504);
      if (at >= 148) at += 8;
      yield one(
        names[Math.floor(random() * names.length)],
        at,
        Math.floor(random() * 256),
      );
    }
    return;
  }
  for (const name of names)
    for (let at = 0; at < 512; at += 1) {
      if (at >= 148 && at < 156) continue;
      for (const value of SWEEP_VALUES) yield one(name, at, value);
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
function* fieldBytes(seed = 1, count = 2000) {
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
function* paxRecords(seed = 1, count = 2000) {
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

/** name -> archives(seed, count); see the comment at the top. */
export const FAMILIES = {
  'byte-sweep': byteSweep,
  'field-bytes': fieldBytes,
  'pax-records': paxRecords,
  'pax-cut': paxCut,
  'meta-order': metaOrder,
  'zero-blocks': zeroBlocks,
};
