import { describe, expect, it } from 'vitest';
import {
  refusalOf,
  type Case,
  BASE,
  edit,
  sectionKey,
} from './read-support.test-helpers.js';

const REFUSALS: Case[] = [
  // the top level
  [
    'no lockfileVersion',
    edit(BASE, "lockfileVersion: '9.0'\n", ''),
    'version',
    'no lockfileVersion',
  ],
  [
    'an older lockfileVersion',
    edit(BASE, "'9.0'", "'6.0'"),
    'version',
    '"6.0"',
  ],
  [
    'lockfileVersion 5.4 unquoted',
    edit(BASE, "'9.0'", '5.4'),
    'version',
    '5.4',
  ],
  [
    'lockfileVersion 9.0 unquoted',
    edit(BASE, "'9.0'", '9.0'),
    'version',
    'only',
  ],
  [
    'a top level key pnpm does not write',
    sectionKey('workspaces', '[a]'),
    'unknown-key',
    '"workspaces"',
  ],
  ['a top level list', '- a\n- b\n', 'shape', 'a mapping'],
  ['a top level string', 'lockfileVersion\n', 'shape', 'a mapping'],
  ['an empty file', '', 'yaml-syntax', 'empty'],
  // settings and the small sections
  [
    'an unknown setting',
    sectionKey('settings', '\n  nodeLinker: hoisted'),
    'unknown-key',
    '"nodeLinker"',
  ],
  [
    'a setting that is not a boolean',
    sectionKey('settings', '\n  autoInstallPeers: yes please'),
    'shape',
    'true or false',
  ],
  [
    'peersSuffixMaxLength of zero',
    sectionKey('settings', '\n  peersSuffixMaxLength: 0'),
    'shape',
    'positive whole number',
  ],
  [
    'peersSuffixMaxLength quoted',
    sectionKey('settings', "\n  peersSuffixMaxLength: '1000'"),
    'shape',
    'positive whole number',
  ],
  [
    'overrides as a list',
    sectionKey('overrides', '\n  - a'),
    'shape',
    'a mapping',
  ],
  [
    'an override that is a number',
    sectionKey('overrides', '\n  a: 1'),
    'shape',
    'a string',
  ],
  [
    'catalogs entry without a version',
    sectionKey('catalogs', '\n  default:\n    a:\n      specifier: ^1.0.0'),
    'shape',
    'version',
  ],
  [
    'catalogs entry with an extra key',
    sectionKey(
      'catalogs',
      '\n  default:\n    a:\n      specifier: ^1.0.0\n      version: 1.0.0\n      extra: 1',
    ),
    'unknown-key',
    '"extra"',
  ],
  [
    'a catalog dependency named like a path',
    sectionKey(
      'catalogs',
      '\n  default:\n    ../a:\n      specifier: ^1.0.0\n      version: 1.0.0',
    ),
    'name',
    'not an npm package name',
  ],
  [
    'a patch with an absolute path',
    sectionKey(
      'patchedDependencies',
      '\n  a@1.0.0:\n    hash: abc\n    path: /etc/passwd',
    ),
    'unsafe-path',
    'absolute',
  ],
  [
    'a patch that leaves the project',
    sectionKey(
      'patchedDependencies',
      '\n  a@1.0.0:\n    hash: abc\n    path: ../x.patch',
    ),
    'unsafe-path',
    'leaves the project',
  ],
  [
    'a patch without a hash',
    sectionKey('patchedDependencies', '\n  a@1.0.0:\n    path: p.patch'),
    'shape',
    'hash',
  ],
  [
    'a patch hash in upper case',
    sectionKey(
      'patchedDependencies',
      '\n  a@1.0.0:\n    hash: ABC\n    path: p.patch',
    ),
    'shape',
    'hash',
  ],
  [
    'a patch for a package named like a path',
    sectionKey(
      'patchedDependencies',
      '\n  ../evil@1.0.0:\n    hash: abc\n    path: p.patch',
    ),
    'name',
    'not an npm package name',
  ],
  [
    'a checksum with a space',
    sectionKey('pnpmfileChecksum', "'a b'"),
    'shape',
    'digest',
  ],
  [
    'a checksum that is a number',
    sectionKey('packageExtensionsChecksum', '12'),
    'shape',
    'a string',
  ],
  [
    'ignoredOptionalDependencies as a string',
    sectionKey('ignoredOptionalDependencies', 'fsevents'),
    'shape',
    'a list',
  ],
  [
    'an empty ignored name',
    sectionKey('ignoredOptionalDependencies', "\n  - ''"),
    'shape',
    'empty string',
  ],
  ['time as a list', sectionKey('time', '\n  - a'), 'shape', 'a mapping'],
];

describe('parsePnpmLock: refusing the top level and the small sections', () => {
  it.each(REFUSALS)('refuses %s', (_label, text, reason, fragment) => {
    const error = refusalOf(text);
    expect(error.code).toBe('INVALID_LOCKFILE');
    expect(error.reason).toBe(reason);
    expect(error.message).toContain(fragment);
  });
});
