import { describe, it } from 'vitest';
import {
  expectNoNewLines,
  member,
  npmFiles,
  renameKey,
  type Json,
} from './repo-fixture.js';

/**
 * A cloned repository cannot add a line to what `opm ci` writes. The values in
 * its package.json and package-lock.json are repeated in the errors `opm ci`
 * raises, so each is made one line where it is repeated, and the lists the
 * command writes (an entry to a line) keep only their own line feeds.
 */

const CI = ['ci', '--offline'];

type Edit = (lock: Json, manifest: Json, text: string) => void;

/** A package.json and package-lock.json with `edit` applied to them. */
const repo = (variant: 'plain' | 'links', edit: Edit) => (text: string) =>
  npmFiles(variant, (lock, manifest) => edit(lock, manifest, text));

describe('opm ci, in a repository whose package.json names a dependency', () => {
  it.each<[string, Edit]>([
    [
      'the lock lacks',
      (_lock, manifest, text) =>
        renameKey(member(manifest, 'dependencies'), 'a', `a${text}`),
    ],
    [
      'only as a development dependency',
      (_lock, manifest, text) =>
        renameKey(member(manifest, 'devDependencies'), 'd', `d${text}`),
    ],
  ])('one line, when it is a name %s', async (_, edit) => {
    await expectNoNewLines(repo('plain', edit), CI);
  });
});

describe('opm ci, in a repository whose lock holds', () => {
  it.each<[string, Edit]>([
    [
      'a dependency the root asks for under another name',
      (lock, _manifest, text) =>
        renameKey(
          member(lock, 'packages', '', 'dependencies'),
          'a',
          `a${text}`,
        ),
    ],
    [
      'a lockfileVersion that is not 2 or 3',
      (lock, _manifest, text) => {
        lock.lockfileVersion = `3${text}`;
      },
    ],
    [
      'a package whose version is not in the store',
      (lock, _manifest, text) => {
        member(lock, 'packages', 'node_modules/a').version = `1.0.0${text}`;
      },
    ],
    [
      'a package whose os is not this machine',
      (lock, _manifest, text) => {
        member(lock, 'packages', 'node_modules/a').os = [`aix${text}`];
      },
    ],
    [
      'a package whose cpu is not this machine',
      (lock, _manifest, text) => {
        member(lock, 'packages', 'node_modules/a').cpu = [`s390${text}`];
      },
    ],
    [
      'a package the policy refuses by its version',
      (lock, _manifest, text) => {
        member(lock, 'packages', 'node_modules/b').version = `1.0.0${text}`;
      },
    ],
    [
      'a package under another name than its path',
      (lock, _manifest, text) => {
        member(lock, 'packages', 'node_modules/alias').name = `real${text}`;
      },
    ],
    [
      'a dependency that is not a string',
      (lock, _manifest, text) => {
        member(lock, 'packages', 'node_modules/a').dependencies = {
          [`b${text}`]: 5,
        };
      },
    ],
    [
      'an entry whose version is not a string',
      (lock, _manifest, text) => {
        member(lock, 'packages', 'node_modules/d').version = 5;
        member(lock, 'packages', 'node_modules/d').resolved = `x${text}`;
      },
    ],
  ])('one line, when it is %s', async (_, edit) => {
    await expectNoNewLines(repo('plain', edit), CI);
  });
});

describe('opm ci, in a repository whose lock holds an entry it refuses', () => {
  it.each<[string, Edit]>([
    [
      'a link to somewhere',
      (lock, _manifest, text) => {
        member(lock, 'packages', 'node_modules/lnk').resolved =
          `packages/l${text}`;
      },
    ],
    [
      'a workspace member with a name',
      (lock, _manifest, text) => {
        member(lock, 'packages', 'packages/l').name = `lnk${text}`;
      },
    ],
<<<<<<< ours
    [
      "a workspace member's directory, the member not linked",
      (lock, manifest, text) => {
        // A directory can hold anything in its name but a slash and a NUL.
        const dir = `packages/l${text.replaceAll('/', '_')}`;
        const packages = member(lock, 'packages');
        manifest.workspaces = ['packages/*'];
        member(packages, '').workspaces = ['packages/*'];
        renameKey(packages, 'packages/l', dir);
        delete packages['node_modules/lnk'];
        delete member(manifest, 'dependencies').lnk;
        delete member(packages, '', 'dependencies').lnk;
      },
    ],
=======
>>>>>>> theirs
  ])('one line, when it is %s', async (_, edit) => {
    await expectNoNewLines(repo('links', edit), CI);
  });
});

describe('opm ci, in a repository whose files are not JSON', () => {
  it.each(['package.json', 'package-lock.json'])(
    'one line, when %s holds a line feed where JSON ends',
    async (name) => {
      await expectNoNewLines(
        (text) => ({
          ...npmFiles('plain', () => {}),
          [name]: `{"name":${text}`,
        }),
        CI,
      );
    },
  );
});
