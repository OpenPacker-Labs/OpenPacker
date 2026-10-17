/**
 * Cases about single entries: a directory with a size, a file named like a
 * directory.
 */

import { Z, a, b, file, entry } from './blocks.mjs';

const directory = (size) => entry('package/d/', '', { type: '5', size });
/** An entry and its one block of data, 1,024 bytes after a directory header. */
const hidden = file('package/hidden.js', 'hidden');
/** A payload that starts with NUL, as every WebAssembly module does. */
const wasm = file('package/hidden.wasm', '\0asm\u0001\0\0\0hidden');

export const ENTRY_CASES = {
  'a directory with no size, then a file': [a, directory(0), b, Z, Z],
  'a directory with a size hides the entries inside it': [
    a,
    directory(1024),
    hidden,
    Z,
    Z,
  ],
  'a file named like a directory, with a size, hides the entries inside it': [
    a,
    entry('package/d/', '', { size: 1024 }),
    hidden,
    Z,
    Z,
  ],
  'a NUL-typed file named like a directory, with a size, hides the entries inside it':
    [a, entry('package/d/', '', { type: '', size: 1024 }), hidden, Z, Z],
  'a directory with a size hides a header and leaves a payload that starts with NUL':
    [a, directory(512), wasm, Z, Z],
  'a file named like a directory, with no size': [
    a,
    entry('package/d/', ''),
    Z,
    Z,
  ],
};
