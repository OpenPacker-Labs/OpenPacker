#!/usr/bin/env node
/**
 * Write oracle.json: what pnpm's own code does with each case of cases.mjs.
 *
 *   node generate.mjs <pnpm 10.28.0 package dir> <pnpm 9.15.0 package dir> [--check]
 *
 * Nothing is installed and pnpm's command line is not run. The two bundles
 * (`dist/pnpm.cjs`) are read, cut before the code that starts the command line,
 * and the modules named below are taken from them by their source path:
 *
 * - `../patching/apply-patch/lib/index.js` of 10.28 (`applyPatchToDir`, what
 *   pnpm calls for each patched package), over a package written to a fresh
 *   temporary directory: the outcome, and every file after it;
 * - `../lockfile/settings-checker/lib/calcPatchHashes.js` of 10.28 and of 9.15
 *   (what writes `patchedDependencies` into a lock): the `{ hash, path }` of a
 *   patch file.
 *
 * `--check` regenerates and compares with the committed file, exiting 1 on any
 * difference.
 */

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { APPLY_CASES, HASH_CASES } from './cases.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const OUTPUT = join(here, 'oracle.json');
const START = 'process.setMaxListeners(0);\nvar argv = process.argv.slice(2);';

/** The named modules of a pnpm bundle, without running pnpm. */
function loadBundle(directory, wanted, modules) {
  const manifest = JSON.parse(
    readFileSync(join(directory, 'package.json'), 'utf8'),
  );
  if (manifest.version !== wanted)
    throw new Error(`${directory} is pnpm ${manifest.version}, not ${wanted}`);
  const file = join(directory, 'dist', 'pnpm.cjs');
  const text = readFileSync(file, 'utf8');
  const at = text.indexOf(START);
  if (at === -1 || text.indexOf(START, at + 1) !== -1)
    throw new Error(`${file}: the command line's start is not found once`);
  const names = modules.map((path) => {
    const pattern = new RegExp(
      `var (require_\\w+) = __commonJS\\(\\{\\n  "${path.replace(/[.*+?^${}()|[\]\\/]/gu, '\\$&')}"`,
      'gu',
    );
    const found = [...text.matchAll(pattern)];
    if (found.length !== 1)
      throw new Error(`${file}: ${path} is defined ${found.length} times`);
    return found[0][1];
  });
  const body = `${text.slice(0, at)}\nreturn [${names.join(', ')}];`;
  const module = { exports: {} };
  // SAFETY: the code evaluated is the pnpm release named on the command line.
  const requires = new Function(
    'exports',
    'require',
    'module',
    '__filename',
    '__dirname',
    body,
  )(module.exports, createRequire(file), module, file, dirname(file));
  return requires.map((load) => load());
}

function writeTree(root, files) {
  for (const [path, value] of Object.entries(files)) {
    const where = join(root, ...path.split('/'));
    mkdirSync(dirname(where), { recursive: true });
    const text = typeof value === 'string' ? value : value.text;
    writeFileSync(where, text);
    chmodSync(where, typeof value === 'string' ? 0o644 : 0o755);
  }
}

function readTree(root) {
  const out = {};
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const where = join(directory, entry.name);
      if (entry.isDirectory()) walk(where);
      else
        out[relative(root, where).split('\\').join('/')] = {
          text: readFileSync(where, 'utf8'),
          executable: (statSync(where).mode & 0o111) !== 0,
        };
    }
  };
  walk(root);
  return Object.fromEntries(
    Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)),
  );
}

async function generate(pnpm10, pnpm9) {
  const [applyPatch, hashes10] = loadBundle(pnpm10, '10.28.0', [
    '../patching/apply-patch/lib/index.js',
    '../lockfile/settings-checker/lib/calcPatchHashes.js',
  ]);
  const [hashes9] = loadBundle(pnpm9, '9.15.0', [
    '../lockfile/settings-checker/lib/calcPatchHashes.js',
  ]);
  const scratch = mkdtempSync(join(tmpdir(), 'pnpm-patch-oracle-'));
  const results = { apply: [], hash: [] };
  try {
    for (const [index, item] of APPLY_CASES.entries()) {
      const root = join(scratch, `apply-${index}`);
      const pkg = join(root, 'package');
      mkdirSync(pkg, { recursive: true });
      writeTree(pkg, item.files);
      const patchFile = join(root, 'case.patch');
      writeFileSync(patchFile, item.patch);
      let outcome;
      try {
        applyPatch.applyPatchToDir({
          allowFailure: false,
          patchedDir: pkg,
          patchFilePath: patchFile,
        });
        outcome = 'applied';
      } catch (error) {
        outcome = error.code;
      }
      results.apply.push({
        ...item,
        outcome,
        ...(outcome === 'applied' && { after: readTree(pkg) }),
      });
    }
    const hash = await Promise.all(
      HASH_CASES.map(async (item, index) => {
        const root = join(scratch, `hash-${index}`);
        const file = join(root, 'patches', 'a@1.0.0.patch');
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, Buffer.from(item.base64, 'base64'));
        const [ten, nine] = await Promise.all([
          hashes10.calcPatchHashes({ 'a@1.0.0': file }, root),
          hashes9.calcPatchHashes({ 'a@1.0.0': file }, root),
        ]);
        return { ...item, pnpm10: ten['a@1.0.0'], pnpm9: nine['a@1.0.0'] };
      }),
    );
    return {
      generatedWith: {
        apply:
          'pnpm 10.28.0 dist/pnpm.cjs: applyPatchToDir of ../patching/apply-patch/lib/index.js (@pnpm/patch-package 0.0.1) with allowFailure false',
        hash: 'calcPatchHashes of ../lockfile/settings-checker/lib/calcPatchHashes.js in pnpm 10.28.0 (pnpm10) and pnpm 9.15.0 (pnpm9)',
      },
      apply: results.apply,
      hash,
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const [pnpm10, pnpm9, flag] = process.argv.slice(2);
if (pnpm10 === undefined || pnpm9 === undefined) {
  process.stderr.write(
    'usage: node generate.mjs <pnpm 10.28.0 dir> <pnpm 9.15.0 dir> [--check]\n',
  );
  process.exit(2);
}
const cwd = process.cwd();
const oracle = await generate(pnpm10, pnpm9);
process.chdir(cwd);
if (flag === '--check') {
  const committed = JSON.parse(readFileSync(OUTPUT, 'utf8'));
  if (!isDeepStrictEqual(committed, oracle)) {
    process.stderr.write('oracle.json differs from what pnpm gives now\n');
    process.exit(1);
  }
  process.stdout.write(
    `oracle.json matches: ${oracle.apply.length} patches, ${oracle.hash.length} hashes\n`,
  );
} else {
  writeFileSync(OUTPUT, `${JSON.stringify(oracle, null, 2)}\n`);
  process.stdout.write(
    `wrote ${OUTPUT}: ${oracle.apply.length} patches, ${oracle.hash.length} hashes\n`,
  );
}
