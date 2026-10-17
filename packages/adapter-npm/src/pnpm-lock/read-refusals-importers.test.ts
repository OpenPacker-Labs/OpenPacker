import { describe, expect, it } from 'vitest';
import {
  refusalOf,
  type Case,
  BASE,
  edit,
  importerEntry,
  importerId,
} from './read-support.test-helpers.js';

const REFUSALS: Case[] = [
  // importers
  [
    'an importer id that is absolute',
    importerId('/etc'),
    'unsafe-path',
    'absolute',
  ],
  [
    'an importer id that climbs out',
    importerId('../x'),
    'unsafe-path',
    'leaves the project',
  ],
  [
    'an importer id with a dot segment',
    importerId('a/./b'),
    'unsafe-path',
    'normalized',
  ],
  [
    'an importer id with a trailing slash',
    importerId('a/'),
    'unsafe-path',
    'normalized',
  ],
  [
    'an importer id with a backslash',
    importerId("'a\\b'"),
    'unsafe-path',
    'backslash',
  ],
  [
    'an importer id in node_modules',
    importerId('a/node_modules/b'),
    'unsafe-path',
    'node_modules',
  ],
  [
    'an importer that is a list',
    edit(
      BASE,
      '  .:\n    dependencies:\n      a:\n        specifier: ^1.0.0\n        version: 1.0.0',
      '  .:\n    - a',
    ),
    'shape',
    'a mapping',
  ],
  [
    'an importer with the old specifiers key',
    edit(
      BASE,
      '    dependencies:\n',
      '    specifiers:\n      a: ^1.0.0\n    dependencies:\n',
    ),
    'unknown-key',
    '"specifiers"',
  ],
  [
    'an importer key only pnpm 11 writes',
    edit(
      BASE,
      '    dependencies:\n',
      '    publishDirectory: dist\n    linkDirectory: false\n    dependencies:\n',
    ),
    'unknown-key',
    '"linkDirectory"',
  ],
  [
    'a dependency without a specifier',
    importerEntry('      a:\n        version: 1.0.0'),
    'shape',
    'specifier',
  ],
  [
    'a dependency without a version',
    importerEntry('      a:\n        specifier: ^1.0.0'),
    'shape',
    'version',
  ],
  [
    'a dependency written as a bare version',
    importerEntry('      a: 1.0.0'),
    'shape',
    'a mapping',
  ],
  [
    'a dependency with an extra key',
    importerEntry(
      '      a:\n        specifier: ^1.0.0\n        version: 1.0.0\n        extra: 1',
    ),
    'unknown-key',
    '"extra"',
  ],
  [
    'a dependency version that is a number',
    importerEntry('      a:\n        specifier: ^1.0.0\n        version: 1.5'),
    'shape',
    'a number',
  ],
  [
    'a dependency version that is not a version',
    importerEntry(
      '      a:\n        specifier: ^1.0.0\n        version: latest',
    ),
    'dep-path',
    'version',
  ],
  [
    'a dependency named like a path',
    importerEntry(
      '      ../x:\n        specifier: ^1.0.0\n        version: 1.0.0',
    ),
    'name',
    'not an npm package name',
  ],
  [
    'a link out of the filesystem',
    importerEntry(
      '      a:\n        specifier: link:/etc\n        version: link:/etc',
    ),
    'unsafe-path',
    'absolute',
  ],
  [
    'a publish directory that climbs out',
    edit(
      BASE,
      '    dependencies:\n',
      '    publishDirectory: ../out\n    dependencies:\n',
    ),
    'unsafe-path',
    'leaves the project',
  ],
  [
    'dependenciesMeta with an unknown key',
    edit(
      BASE,
      '    dependencies:\n',
      '    dependenciesMeta:\n      a:\n        hoisted: true\n    dependencies:\n',
    ),
    'unknown-key',
    '"hoisted"',
  ],
];

describe('parsePnpmLock: refusing importers', () => {
  it.each(REFUSALS)('refuses %s', (_label, text, reason, fragment) => {
    const error = refusalOf(text);
    expect(error.code).toBe('INVALID_LOCKFILE');
    expect(error.reason).toBe(reason);
    expect(error.message).toContain(fragment);
  });
});
