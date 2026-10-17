#!/usr/bin/env node
/**
 * Write oracle.json: what npm's and pnpm's own tar readers install from each
 * case in cases.mjs: archives the two read differently, and archives they
 * read alike. Paths are recorded as installed,
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
 * node-tar is fed each case as one buffer (`nodeTar`) and in pieces of 1, 1,460,
 * 16,384 and 65,536 bytes; `fed` holds the entries for each piece size that
 * reads differently, so a case whose answer depends on how it was fed shows.
 *
 * Each case also records `pacote`: the files `tar.x` writes with pacote's own
 * filter (pacote.mjs), which skips what is no file and renames `.gitignore`.
 *
 * `--check` regenerates and compares with the committed file, exiting 1 on any
 * difference.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { CASES } from './cases.mjs';
import { pacoteInstalls } from './pacote.mjs';
import {
  FEEDS,
  loadNodeTar,
  loadParseTarball,
  nodeTar,
  pnpm,
} from './readers.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const OUTPUT = join(here, 'oracle.json');

async function generate(nodeTarDirectory, pnpmDirectory) {
  const tar = loadNodeTar(nodeTarDirectory);
  const { Parse } = tar;
  const parseTarball = loadParseTarball(pnpmDirectory);
  const cases = [];
  for (const [name, parts] of Object.entries(CASES)) {
    const bytes = Buffer.concat(parts);
    const nodeTarWhole = await nodeTar(Parse, bytes);
    const fed = {};
    for (const piece of FEEDS) {
      const read = await nodeTar(Parse, bytes, piece);
      if (!isDeepStrictEqual(read.entries, nodeTarWhole.entries))
        fed[piece] = read.entries;
    }
    cases.push({
      name,
      bytes: bytes.toString('base64'),
      nodeTar: nodeTarWhole,
      fed,
      pacote: await pacoteInstalls(tar, bytes),
      pnpm: pnpm(parseTarball, bytes),
    });
  }
  return { nodeTar: '6.2.1', pnpm: '10.28.0', cases };
}

/** The file as the repository's prettier writes it, so format:check passes on it. */
async function formatted(text) {
  const prettier = await import('prettier');
  const options = (await prettier.resolveConfig(OUTPUT)) ?? {};
  return prettier.format(text, { ...options, filepath: OUTPUT });
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
  writeFileSync(
    OUTPUT,
    await formatted(`${JSON.stringify(oracle, null, 2)}\n`),
  );
  console.log(`wrote ${OUTPUT}: ${oracle.cases.length} cases`);
}
