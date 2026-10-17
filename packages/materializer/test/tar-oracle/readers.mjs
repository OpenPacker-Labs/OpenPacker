/**
 * The two readers the oracle and the fuzz compare opm with: node-tar 6.2.1's
 * `Parse` (npm), fed a buffer whole or in pieces, and pnpm 10.28.0's
 * `parseTarball`, both loaded from the release directories named on the command
 * line.
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

/** node-tar 6.2.1 (as npm 10.9 bundles it), loaded from its package directory. */
export function loadNodeTar(directory) {
  const manifest = JSON.parse(
    readFileSync(join(directory, 'package.json'), 'utf8'),
  );
  if (manifest.name !== 'tar' || manifest.version !== '6.2.1')
    throw new Error(`${directory} is not tar 6.2.1`);
  return createRequire(join(directory, 'package.json'))(directory);
}

/**
 * The pieces node-tar is fed in besides one buffer: 1 byte at a time (it
 * consumes 512-byte units), a network segment, zlib's output chunk and a
 * larger read. It decodes a pax header of more than one block piece by piece.
 */
export const FEEDS = [1, 1460, 16384, 65536];

/** The files node-tar reads, as pacote installs them: `strip: 1`, fed in pieces of `piece` bytes. */
export async function nodeTar(Parse, bytes, piece = bytes.length) {
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
    for (let at = 0; at < bytes.length; at += piece)
      parser.write(bytes.subarray(at, at + piece));
    parser.end();
  });
  return { entries, warnings };
}

export function pnpm(parseTarball, bytes) {
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
