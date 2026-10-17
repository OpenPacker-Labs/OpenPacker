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
 * Each case also records `pacote`: the files `tar.x` writes with pacote's own
 * filter (pacote.mjs), which skips what is no file and renames `.gitignore`.
 *
 * `--check` regenerates and compares with the committed file, exiting 1 on any
 * difference.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { CASES } from './cases.mjs';
import { pacoteInstalls } from './pacote.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const OUTPUT = join(here, 'oracle.json');
const START = 'process.setMaxListeners(0);\nvar argv = process.argv.slice(2);';

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
  const tar = createRequire(join(nodeTarDirectory, 'package.json'))(
    nodeTarDirectory,
  );
  const { Parse } = tar;
  const parseTarball = loadParseTarball(pnpmDirectory);
  const cases = [];
  for (const [name, parts] of Object.entries(CASES)) {
    const bytes = Buffer.concat(parts);
    cases.push({
      name,
      bytes: bytes.toString('base64'),
      nodeTar: await nodeTar(Parse, bytes),
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
