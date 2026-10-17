#!/usr/bin/env node
/**
 * Write oracle.json: what npm's and pnpm's own tar readers install from each
 * case below: archives whose end, checksum, prefix or name the two read
 * differently, and archives they read alike. Paths are recorded as installed,
 * the first component stripped (pacote's `strip: 1`; pnpm strips it itself).
 *
 *   node generate.mjs <node-tar 6.2.1 package dir> <pnpm 10.28.0 package dir> [--check]
 *
 * npm extracts with node-tar (`Parse`, here 6.2.1 as npm 10.9 bundles it);
 * pnpm with its own `parseTarball` (`../store/cafs/lib/parseTarball.js`, taken
 * from the 10.28.0 bundle by its source path, cut before the command line
 * starts, as test/pnpm-patch-oracle does). Each case's bytes are written into
 * the oracle, so the test reads the very bytes the readers were given.
 *
 * `--check` regenerates and compares with the committed file, exiting 1 on any
 * difference.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const here = dirname(fileURLToPath(import.meta.url));
const OUTPUT = join(here, 'oracle.json');
const START = 'process.setMaxListeners(0);\nvar argv = process.argv.slice(2);';

/**
 * A header and the data of a regular file, padded to whole blocks: ustar, its
 * checksum written `NNNNNN\0 `, unless `edit` changes the header first or
 * `checksum` writes the field another way.
 */
function file(name, text, { prefix = '', edit, checksum } = {}) {
  const body = Buffer.from(text);
  const header = Buffer.alloc(512);
  header.write(name, 0);
  header.write('0000644\0', 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124);
  header.write('00000000000\0', 136);
  header.write('        ', 148);
  header.write('0', 156);
  header.write('ustar\0', 257);
  header.write('00', 263);
  header.write(prefix, 345);
  edit?.(header);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(
    checksum?.(sum) ?? `${sum.toString(8).padStart(6, '0')}\0 `,
    148,
  );
  return Buffer.concat([
    header,
    body,
    Buffer.alloc((512 - (body.length % 512)) % 512),
  ]);
}

const Z = Buffer.alloc(512);
const a = file('package/a.js', 'a');
const b = file('package/b.js', 'b');
const c = file('package/c.js', 'c');
/** 512 bytes that are not zero and not a header. */
const garbage = Buffer.alloc(512, 0x41);
/** What node-tar takes for a null block: a checksum field that is no number, every other byte zero. */
const N = Buffer.alloc(512);
N.write('        ', 148);

export const CASES = {
  'two zero blocks end it': [a, Z, Z],
  'a whole record of zeros ends it': [a, Buffer.alloc(9216)],
  'the end of the data ends it': [a],
  'one zero block at the end of the data ends it': [a, Z],
  'nothing after two zero blocks is read': [a, Z, Z, b, Z, Z],
  'a lone zero block between entries': [a, Z, b, Z, Z],
  'lone zero blocks between three entries': [a, Z, b, Z, c, Z, Z],
  'a lone zero block before the first entry': [Z, a, Z, Z],
  'a lone zero block, then a block that is not a header': [a, Z, garbage, Z, Z],
  'a lone zero block, a block that is not a header, then an entry': [
    a,
    Z,
    garbage,
    b,
    Z,
    Z,
  ],
  'a node-tar null block between entries': [a, N, b, Z, Z],
  'a lone zero block, then a node-tar null block': [a, Z, N, b],
  'a node-tar null block, then a zero block': [a, N, Z, b],
};

function loadParseTarball(directory) {
  const manifest = JSON.parse(
    readFileSync(join(directory, 'package.json'), 'utf8'),
  );
  if (manifest.version !== '10.28.0')
    throw new Error(`${directory} is pnpm ${manifest.version}, not 10.28.0`);
  const bundle = join(directory, 'dist', 'pnpm.cjs');
  const text = readFileSync(bundle, 'utf8');
  const at = text.indexOf(START);
  if (at === -1 || text.indexOf(START, at + 1) !== -1)
    throw new Error(`${bundle}: the command line's start is not found once`);
  const found = [
    ...text.matchAll(
      /var (require_\w+) = __commonJS\(\{\n {2}"\.\.\/store\/cafs\/lib\/parseTarball\.js"/gu,
    ),
  ];
  if (found.length !== 1)
    throw new Error(`${bundle}: parseTarball is defined ${found.length} times`);
  const module = { exports: {} };
  // SAFETY: the code evaluated is the pnpm release named on the command line.
  const load = new Function(
    'exports',
    'require',
    'module',
    '__filename',
    '__dirname',
    `${text.slice(0, at)}\nreturn ${found[0][1]};`,
  )(module.exports, createRequire(bundle), module, bundle, dirname(bundle));
  return load().parseTarball;
}

/** The files node-tar reads, as pacote installs them: `strip: 1`. */
async function nodeTar(Parse, bytes) {
  const entries = [];
  const warnings = [];
  const parser = new Parse({
    onentry: (entry) => {
      const chunks = [];
      entry.on('data', (chunk) => chunks.push(chunk));
      entry.on('end', () => {
        const installed = entry.path.split('/').slice(1).join('/');
        if (/^(?:Old|Contiguous)?File$/u.test(entry.type) && installed !== '')
          entries.push([installed, Buffer.concat(chunks).toString()]);
      });
    },
    onwarn: (code) => warnings.push(code),
  });
  await new Promise((resolve, reject) => {
    parser.on('end', resolve);
    parser.on('error', reject);
    parser.end(bytes);
  });
  return { entries, warnings };
}

function pnpm(parseTarball, bytes) {
  try {
    const { files } = parseTarball(bytes);
    return {
      entries: [...files].map(([path, { offset, size }]) => [
        path,
        bytes.subarray(offset, offset + size).toString(),
      ]),
    };
  } catch (error) {
    return { error: error.message };
  }
}

async function generate(nodeTarDirectory, pnpmDirectory) {
  const tarManifest = JSON.parse(
    readFileSync(join(nodeTarDirectory, 'package.json'), 'utf8'),
  );
  if (tarManifest.name !== 'tar' || tarManifest.version !== '6.2.1')
    throw new Error(`${nodeTarDirectory} is not tar 6.2.1`);
  const { Parse } = createRequire(join(nodeTarDirectory, 'package.json'))(
    nodeTarDirectory,
  );
  const parseTarball = loadParseTarball(pnpmDirectory);
  const cases = [];
  for (const [name, parts] of Object.entries(CASES)) {
    const bytes = Buffer.concat(parts);
    cases.push({
      name,
      bytes: bytes.toString('base64'),
      nodeTar: await nodeTar(Parse, bytes),
      pnpm: pnpm(parseTarball, bytes),
    });
  }
  return { nodeTar: '6.2.1', pnpm: '10.28.0', cases };
}

const [nodeTarDirectory, pnpmDirectory, flag] = process.argv.slice(2);
if (!nodeTarDirectory || !pnpmDirectory) {
  console.error(
    'usage: node generate.mjs <node-tar 6.2.1 dir> <pnpm 10.28.0 dir> [--check]',
  );
  process.exit(2);
}
const oracle = await generate(nodeTarDirectory, pnpmDirectory);
if (flag === '--check') {
  const committed = JSON.parse(readFileSync(OUTPUT, 'utf8'));
  if (!isDeepStrictEqual(committed, oracle)) {
    console.error('oracle.json differs from what the readers do now');
    process.exit(1);
  }
  console.log(`oracle.json matches: ${oracle.cases.length} cases`);
} else {
  writeFileSync(OUTPUT, `${JSON.stringify(oracle, null, 2)}\n`);
  console.log(`wrote ${OUTPUT}: ${oracle.cases.length} cases`);
}
