import { describe, it } from 'vitest';
import {
  expectNoNewLines,
  member,
  npmFiles,
  opmFiles,
  renameKey,
  type Json,
  type TomlSections,
} from './repo-fixture.js';

/**
 * A cloned repository cannot add a line to what `opm list`, `opm why` and
 * `opm import --native` write to stdout, nor an escape sequence to a terminal.
 * Nothing sits between those commands and the stream, so each value of the
 * repository's files that they print is made one line where it is printed.
 */

type Edit = (lock: Json, toml: TomlSections, text: string) => void;

const repo = (edit: Edit) => (text: string) =>
  opmFiles((lock, toml) => edit(lock, toml, text));

describe('opm list, in a repository whose opm.lock.json holds', () => {
  it.each<[string, Edit]>([
    [
      'an alias',
      (lock, _toml, text) =>
        renameKey(member(lock, 'packages'), 'a', `a${text}`),
    ],
    [
      'a purl',
      (lock, _toml, text) => {
        member(lock, 'packages', 'a').purl = `pkg:npm/a@1.0.0${text}`;
      },
    ],
    [
      'a digest',
      (lock, _toml, text) => {
        member(lock, 'packages', 'a').digest = `sha256:${text}`;
      },
    ],
    [
      'a bin name',
      (lock, _toml, text) => {
        member(lock, 'packages', 'a').bins = [
          { name: `ax${text}`, path: 'x.js' },
        ];
      },
    ],
<<<<<<< ours
    [
      'a name another package installs it under',
      (lock, _toml, text) => {
        member(lock, 'packages').b = {
          ...member(lock, 'packages', 'a'),
          reason: 'transitive',
          purl: 'pkg:npm/b@1.0.0',
          aliases: { [`ax${text}`]: 'a' },
        };
      },
    ],
=======
>>>>>>> theirs
  ])('one line a package, when it is %s', async (_, edit) => {
    await expectNoNewLines(repo(edit), ['list']);
  });
});

describe('opm why, in a repository whose files hold', () => {
  it.each<[string, Edit]>([
    [
      'a purl in opm.toml',
      (_lock, toml, text) => {
        toml.a.purl = `pkg:npm/a${text}`;
      },
    ],
    [
      'a version constraint in opm.toml',
      (_lock, toml, text) => {
        toml.a.version = `1.0.0${text}`;
      },
    ],
    [
      'a source in opm.toml',
      (_lock, toml, text) => {
        toml.a.source = `https://registry.example.test/a.tgz${text}`;
      },
    ],
    [
      'a purl in opm.lock.json',
      (lock, _toml, text) => {
        member(lock, 'packages', 'a').purl = `pkg:npm/a@1.0.0${text}`;
      },
    ],
    [
      'a digest in opm.lock.json',
      (lock, _toml, text) => {
        member(lock, 'packages', 'a').digest = `sha256:${text}`;
      },
    ],
  ])('one line, when it is %s', async (_, edit) => {
    await expectNoNewLines(repo(edit), ['why', 'a']);
  });

<<<<<<< ours
  it.each<[string, Edit]>([
    [
      'the name a package requires it under',
      (lock, _toml, text) => {
        member(lock, 'packages').b = {
          ...member(lock, 'packages', 'a'),
          reason: 'transitive',
          purl: 'pkg:npm/b@1.0.0',
          aliases: { [`ax${text}`]: 'a' },
        };
      },
    ],
    [
      'the key of the package that requires it',
      (lock, _toml, text) => {
        member(lock, 'packages')[`b${text}`] = {
          ...member(lock, 'packages', 'a'),
          reason: 'transitive',
          purl: 'pkg:npm/b@1.0.0',
          dependencies: ['a'],
        };
      },
    ],
    [
      'the PURL of the package that requires it',
      (lock, _toml, text) => {
        member(lock, 'packages').b = {
          ...member(lock, 'packages', 'a'),
          reason: 'transitive',
          purl: `pkg:npm/b@1.0.0${text}`,
          dependencies: ['a'],
        };
      },
    ],
  ])('one line a requirer, when opm.lock.json holds %s', async (_, edit) => {
    await expectNoNewLines(repo(edit), ['why', 'a']);
  });

=======
>>>>>>> theirs
  it('one line, when the package is only in the lock', async () => {
    await expectNoNewLines(
      repo((lock, _toml, text) => {
        member(lock, 'packages').b = {
          ...member(lock, 'packages', 'a'),
          reason: 'transitive',
          purl: `pkg:npm/b@1.0.0${text}`,
        };
      }),
      ['why', 'b'],
    );
  });
});

describe('opm import --native, in a repository whose package.json holds', () => {
  it.each<[string, (manifest: Json, text: string) => void]>([
    [
      'a version range',
      (manifest, text) => {
        member(manifest, 'dependencies').a = `^1.0.0${text}`;
      },
    ],
    [
      'a development version range',
      (manifest, text) => {
        member(manifest, 'devDependencies').d = `1.0.0${text}`;
      },
    ],
    [
      'a dependency name',
      (manifest, text) =>
        renameKey(member(manifest, 'devDependencies'), 'd', `d${text}`),
    ],
  ])('one line, when it is %s', async (_, edit) => {
    await expectNoNewLines(
      (text) => {
        const files = npmFiles('plain', (_lock, manifest) =>
          edit(manifest, text),
        );
        return { 'package.json': files['package.json'] };
      },
      ['import', '--native'],
    );
  });
});
