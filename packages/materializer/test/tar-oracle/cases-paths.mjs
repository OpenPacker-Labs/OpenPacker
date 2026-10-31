/**
 * Cases about how a file's path is spelled: a backslash, no directory above
 * it, another top-level directory, a root of `./`; and the ignore files pacote
 * renames.
 */

import { Z, a, entry, file } from './blocks.mjs';

export const PATH_CASES = {
  'a file whose only path component has a backslash': [
    a,
    file('package\\back.js', 'B'),
    Z,
    Z,
  ],
  'a file with a backslash below the top-level directory': [
    a,
    file('package/lib\\x.js', 'X'),
    Z,
    Z,
  ],
  'a file with no directory above it': [a, file('solo.js', 'S'), Z, Z],
  'a directory name with a backslash': [
    a,
    entry('package/d\\e/', '', { type: '5' }),
    Z,
    Z,
  ],
  'a file in a second top-level directory': [a, file('other/o.js', 'O'), Z, Z],
  'a file whose name starts with ./': [a, file('./package/dot.js', 'd'), Z, Z],
  'a .gitignore file': [a, file('package/.gitignore', 'G'), Z, Z],
  'a .npmignore, then a .gitignore': [
    a,
    file('package/.npmignore', 'N'),
    file('package/.gitignore', 'G'),
    Z,
    Z,
  ],
  'a .gitignore, then a .npmignore': [
    a,
    file('package/.gitignore', 'G'),
    file('package/.npmignore', 'N'),
    Z,
    Z,
  ],
};
