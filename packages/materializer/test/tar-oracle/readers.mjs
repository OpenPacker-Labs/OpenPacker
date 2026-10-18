/**
 * The readers the oracle and the fuzz compare opm with, loaded from the release
 * directories named on the command line: node-tar 6.2.1 (npm 10.9.4's) and
 * node-tar 7.5.22 (npm 11's line), each as `Parse` fed a buffer whole or in
 * pieces; pnpm 10.28.0's `parseTarball`. A read is the files installed, as
 * `[path, text]` with the first path component stripped, and `executable`, the
 * paths whose mode has an execute bit (pnpm's `modeIsExecutable`, `mode & 0o111`).
 * Where each directory comes from is in ../tar-fuzz/README.md.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const START = 'process.setMaxListeners(0);\nvar argv = process.argv.slice(2);';

export function loadParseTarball(directory) {
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

/** The node-tar releases the oracle and the fuzz are pinned to. */
export const NODE_TAR_VERSIONS = ['6.2.1', '7.5.22'];

/**
 * node-tar, loaded from its package directory: 6.2.1 (as npm 10.9 bundles it)
 * or 7.5.22 (npm 11's line, fetched by ../tar-fuzz/fetch-node-tar-7.mjs).
 * `expected` names the one the caller wants, and anything else is an error.
 */
export function loadNodeTar(directory, expected) {
  const manifest = JSON.parse(
    readFileSync(join(directory, 'package.json'), 'utf8'),
  );
  if (
    manifest.name !== 'tar' ||
    !NODE_TAR_VERSIONS.includes(manifest.version) ||
    (expected !== undefined && manifest.version !== expected)
  )
    throw new Error(
      `${directory} is ${manifest.name} ${manifest.version}, not tar ${expected ?? NODE_TAR_VERSIONS.join(' or ')}`,
    );
  const module = createRequire(join(directory, 'package.json'))(directory);
  // 7.x renamed the parser and its entry hook.
  return {
    version: manifest.version,
    module,
    Parse: module.Parse ?? module.Parser,
    entryHook: module.Parse ? 'onentry' : 'onReadEntry',
  };
}

/**
 * The pieces node-tar is fed in besides one buffer: 1 byte at a time (it
 * consumes 512-byte units), a network segment, zlib's output chunk and a
 * larger read. It decodes a pax header of more than one block piece by piece.
 */
export const FEEDS = [1, 1460, 16384, 65536];

const REGULAR = /^(?:Old|Contiguous)?File$/u;
const sorted = (list) => list.sort((left, right) => (left < right ? -1 : 1));

/**
 * The paths whose last entry has an execute bit: a later entry at a path
 * replaces an earlier one, as on disk.
 */
export function executableOf(modes) {
  return sorted([...modes].filter(([, mode]) => mode).map(([path]) => path));
}

/** The files node-tar reads, as pacote installs them: `strip: 1`, fed in pieces of `piece` bytes. */
export async function nodeTar(reader, bytes, piece = bytes.length) {
  const entries = [];
  const modes = new Map();
  const warnings = [];
  const parser = new reader.Parse({
    [reader.entryHook]: (entry) => {
      const chunks = [];
      entry.on('data', (chunk) => chunks.push(chunk));
      entry.on('end', () => {
        const installed = entry.path.split('/').slice(1).join('/');
        if (REGULAR.test(entry.type) && installed !== '') {
          entries.push([installed, Buffer.concat(chunks).toString()]);
          modes.set(installed, ((entry.mode ?? 0) & 0o111) !== 0);
        }
      });
    },
    onwarn: (code) => warnings.push(code),
  });
  await new Promise((resolve, reject) => {
    parser.on('end', resolve);
    parser.on('error', reject);
    for (let at = 0; at < bytes.length; at += piece)
      parser.write(bytes.subarray(at, at + piece));
    parser.end();
  });
  return { entries, executable: executableOf(modes), warnings };
}

export function pnpm(parseTarball, bytes) {
  try {
    const { files } = parseTarball(bytes);
    return {
      entries: [...files].map(([path, { offset, size }]) => [
        path,
        bytes.subarray(offset, offset + size).toString(),
      ]),
      executable: executableOf(
        new Map(
          [...files].map(([path, { mode }]) => [
            path,
            ((mode ?? 0) & 0o111) !== 0,
          ]),
        ),
      ),
    };
  } catch (error) {
    return { error: error.message };
  }
}
