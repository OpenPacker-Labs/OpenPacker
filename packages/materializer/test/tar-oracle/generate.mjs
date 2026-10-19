#!/usr/bin/env node
/**
 * Write oracle.json: what npm's and pnpm's own tar readers install from each
 * case in cases.mjs: archives the readers read differently, and archives they
 * read alike. Paths are recorded as installed, the first component stripped
 * (pacote's `strip: 1`; pnpm strips it itself), with the paths that have an
 * execute bit.
 *
 *   node generate.mjs <node-tar 6.2.1 dir> <pnpm 10.28.0 dir> <node-tar 7.5.22 dir> [--check]
 *
 * npm 10.9 extracts with node-tar 6.2.1 and npm 11 with node-tar 7.5.22 (`Parse`
 * here; ../tar-fuzz/fetch-node-tar-7.mjs fetches the second); pnpm with its own
 * `parseTarball` (`../store/cafs/lib/parseTarball.js`, taken from the 10.28.0
 * bundle by its source path, cut before the command line starts, as
 * test/pnpm-patch-oracle does). Each case's bytes are written into the oracle,
 * so the test reads the very bytes the readers were given.
 *
 * node-tar is fed each case as one buffer (`nodeTar`, `nodeTar7`) and in pieces
 * of 1, 1,460, 16,384 and 65,536 bytes; `fed` and `fed7` hold the answer for each
 * piece size that differs, so a case whose answer depends on how it was fed shows.
 *
 * Each case also records `pacote` and `pacote7`: what `tar.x` writes, with
 * pacote's own filter (pacote.mjs), to a directory, or the way it failed.
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

/** An uncaught exception from inside `tar.x` is an answer (pacote.mjs records it), not the end of the run. */
process.on('uncaughtException', () => undefined);

async function readFed(reader, bytes) {
  const whole = await nodeTar(reader, bytes);
  const fed = {};
  for (const piece of FEEDS) {
    const read = await nodeTar(reader, bytes, piece);
    if (
      !isDeepStrictEqual(
        [read.entries, read.executable],
        [whole.entries, whole.executable],
      )
    )
      fed[piece] = { entries: read.entries, executable: read.executable };
  }
  return { whole, fed };
}

async function generate(directories) {
  const six = loadNodeTar(directories.nodeTar, '6.2.1');
  const seven = loadNodeTar(directories.nodeTar7, '7.5.22');
  const parseTarball = loadParseTarball(directories.pnpm);
  const cases = [];
  for (const [name, parts] of Object.entries(CASES)) {
    const bytes = Buffer.concat(parts);
    const sixRead = await readFed(six, bytes);
    const sevenRead = await readFed(seven, bytes);
    cases.push({
      name,
      bytes: bytes.toString('base64'),
      nodeTar: sixRead.whole,
      fed: sixRead.fed,
      nodeTar7: sevenRead.whole,
      fed7: sevenRead.fed,
      pacote: await pacoteInstalls(six, bytes),
      pacote7: await pacoteInstalls(seven, bytes),
      pnpm: pnpm(parseTarball, bytes),
    });
  }
  return { nodeTar: '6.2.1', nodeTar7: '7.5.22', pnpm: '10.28.0', cases };
}

/** The file as the repository's prettier writes it, so format:check passes on it. */
async function formatted(text) {
  const prettier = await import('prettier');
  const options = (await prettier.resolveConfig(OUTPUT)) ?? {};
  return prettier.format(text, { ...options, filepath: OUTPUT });
}

const [nodeTarDirectory, pnpmDirectory, nodeTar7Directory, flag] =
  process.argv.slice(2);
if (!nodeTarDirectory || !pnpmDirectory || !nodeTar7Directory) {
  console.error(
    'usage: node generate.mjs <node-tar 6.2.1 dir> <pnpm 10.28.0 dir> <node-tar 7.5.22 dir> [--check]',
  );
  process.exit(2);
}
const oracle = await generate({
  nodeTar: nodeTarDirectory,
  pnpm: pnpmDirectory,
  nodeTar7: nodeTar7Directory,
});
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
