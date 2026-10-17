import { describe, expect, it } from 'vitest';
import {
  refusalOf,
  type Case,
  BASE,
  SHA512,
  edit,
  pkg,
  pkgField,
  snapField,
} from './read-support.test-helpers.js';

const REFUSALS: Case[] = [
  // packages
  [
    'a package key with a peer suffix',
    edit(
      BASE,
      '  a@1.0.0:\n    resolution',
      '  a@1.0.0(b@1.0.0):\n    resolution',
    ),
    'dep-path',
    'no peer suffix',
  ],
  [
    'a package key that is not name@version',
    edit(BASE, '  a@1.0.0:\n    resolution', '  a:\n    resolution'),
    'dep-path',
    'no @',
  ],
  [
    'a package without a resolution',
    edit(
      BASE,
      `    resolution: {integrity: ${SHA512}}\n`,
      '    hasBin: true\n',
    ),
    'shape',
    'resolution',
  ],
  ['an empty resolution', pkg('{}'), 'shape', 'must have an integrity'],
  [
    'a resolution with an unknown key',
    pkg(`{integrity: ${SHA512}, registry: x}`),
    'unknown-key',
    '"registry"',
  ],
  [
    'a resolution of a type pnpm does not write',
    pkg('{type: custom, url: x}'),
    'shape',
    '"custom"',
  ],
  [
    'an integrity that is too short',
    pkg('{integrity: sha512-AAAA}'),
    'integrity',
    'digest',
  ],
  [
    'an integrity with the wrong algorithm',
    pkg(`{integrity: md5-${Buffer.alloc(16).toString('base64')}}`),
    'integrity',
    'sha1, sha256',
  ],
  [
    'an integrity that is not text',
    pkg('{integrity: 12}'),
    'shape',
    'a string',
  ],
  [
    'a tarball with credentials',
    pkg('{tarball: "https://user:pw@h/a.tgz"}'),
    'url',
    'password',
  ],
  [
    'a tarball that is not http',
    pkg('{tarball: "ftp://h/a.tgz"}'),
    'url',
    'http',
  ],
  [
    'a directory that is absolute',
    pkg('{directory: /etc, type: directory}'),
    'unsafe-path',
    'absolute',
  ],
  [
    'a directory resolution with a tarball',
    pkg('{directory: ../a, tarball: x, type: directory}'),
    'unknown-key',
    '"tarball"',
  ],
  [
    'a git resolution with a short commit',
    pkg('{commit: abc, repo: "https://h/a.git", type: git}'),
    'shape',
    'commit hash',
  ],
  [
    'a git resolution with a token in the address',
    pkg(
      `{commit: ${'a'.repeat(40)}, repo: "https://TOKEN@h/a.git", type: git}`,
    ),
    'url',
    'credentials',
  ],
  [
    'a git resolution without a repo',
    pkg(`{commit: ${'a'.repeat(40)}, type: git}`),
    'shape',
    'repo',
  ],
  [
    'variations that are not a list',
    pkg('{type: variations, variants: x}'),
    'shape',
    'a list',
  ],
  [
    'a variant with no targets',
    pkg(
      '{type: variations, variants: [{resolution: {type: binary, archive: zip, bin: n, integrity: ' +
        SHA512 +
        ', url: "https://h/n.zip"}}]}',
    ),
    'shape',
    'targets',
  ],
  [
    'a binary that is not a tarball or zip',
    pkg(
      '{type: variations, variants: [{targets: [{os: linux, cpu: x64}], resolution: {type: binary, archive: rar, bin: n, integrity: ' +
        SHA512 +
        ', url: "https://h/n.rar"}}]}',
    ),
    'shape',
    'tarball or zip',
  ],
  ['engines as a list', pkgField('engines: [node]'), 'shape', 'a mapping'],
  [
    'engines with a number',
    pkgField('engines: {node: 18}'),
    'shape',
    'a string',
  ],
  ['cpu as a string', pkgField('cpu: x64'), 'shape', 'a list'],
  ['cpu with an empty entry', pkgField("cpu: ['']"), 'shape', 'empty string'],
  ['hasBin as text', pkgField("hasBin: 'true'"), 'shape', 'true or false'],
  ['deprecated as a list', pkgField('deprecated: [a]'), 'shape', 'a string'],
  [
    'bundledDependencies as a number',
    pkgField('bundledDependencies: 1'),
    'shape',
    'a list',
  ],
  [
    'peerDependenciesMeta with an unknown key',
    pkgField('peerDependenciesMeta:\n      b:\n        required: true'),
    'unknown-key',
    '"required"',
  ],
  [
    'a package field pnpm does not write',
    pkgField('requiresBuild: true'),
    'unknown-key',
    '"requiresBuild"',
  ],
  [
    'a package version that is a range',
    pkgField("version: '^1.0.0'"),
    'shape',
    'semantic version',
  ],
  [
    'a package name that is a path',
    pkgField("name: '../x'"),
    'name',
    'not an npm package name',
  ],
  // snapshots
  [
    'a snapshot that is empty rather than {}',
    edit(BASE, '  a@1.0.0: {}', '  a@1.0.0:'),
    'shape',
    'a mapping',
  ],
  [
    'a snapshot field pnpm does not write',
    snapField('    hasBin: true'),
    'unknown-key',
    '"hasBin"',
  ],
  [
    'a snapshot dependency that is a number',
    snapField('    dependencies:\n      b: 1'),
    'shape',
    'a number',
  ],
  [
    'a snapshot dependency that is not a version',
    snapField('    dependencies:\n      b: latest'),
    'dep-path',
    'version',
  ],
  [
    'a snapshot dependency named like a path',
    snapField("    dependencies:\n      '../b': 1.0.0"),
    'name',
    'not an npm package name',
  ],
  [
    'optional as text',
    snapField("    optional: 'true'"),
    'shape',
    'true or false',
  ],
  [
    'transitivePeerDependencies as a mapping',
    snapField('    transitivePeerDependencies:\n      a: b'),
    'shape',
    'a list',
  ],
  [
    'a snapshot key with an unbalanced suffix',
    edit(BASE, '  a@1.0.0: {}', '  a@1.0.0(b@1.0.0: {}'),
    'dep-path',
    'parenthesis',
  ],
  [
    'a snapshot key that is a version range',
    edit(BASE, '  a@1.0.0: {}', '  a@^1.0.0: {}'),
    'dep-path',
    'version',
  ],
];

describe('parsePnpmLock: refusing packages and snapshots', () => {
  it.each(REFUSALS)('refuses %s', (_label, text, reason, fragment) => {
    const error = refusalOf(text);
    expect(error.code).toBe('INVALID_LOCKFILE');
    expect(error.reason).toBe(reason);
    expect(error.message).toContain(fragment);
  });
});
