import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { configureDefaultAdapters } from '@openpacker/adapters-default';
import {
  addPackage,
  initProject,
  listInstalled,
  projectPaths,
  readLockfile,
  readManifestFile,
  readProjectState,
  writeManifestFile,
} from '../src/index.js';
import { permissive } from './closure-support.js';
import {
  NpmRegistryFixture,
  type FixturePackage,
} from './npm-registry-fixture.js';

configureDefaultAdapters();

/**
 * `opm add` after `opm add`, as a person does it (ADR 0054). A name that is
 * held once is keyed by its name and a name held at two versions is keyed per
 * version, so adding the package that makes it two changes the key of the first
 * copy. What was installed under the old key is not installed any more.
 */

const registry = (): FixturePackage[] => [
  {
    name: 'string-width',
    versions: {
      '4.2.3': {
        dependencies: { 'strip-ansi': '^6.0.1' },
        files: {
          'index.js':
            "module.exports = { inner: require('strip-ansi').version };\n",
        },
      },
    },
  },
  {
    name: 'strip-ansi',
    versions: {
      '6.0.1': { dependencies: { 'ansi-regex': '^5.0.1' }, files: {} },
      '7.1.0': { dependencies: { 'ansi-regex': '^6.0.1' }, files: {} },
    },
  },
  {
    name: 'ansi-regex',
    versions: { '5.0.1': { files: {} }, '6.4.0': { files: {} } },
  },
];

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'opm-add-keys-'));
  roots.push(root);
  await initProject({ root, name: 'adds' });
  const paths = projectPaths(root);
  const manifest = await readManifestFile(paths.manifest);
  manifest.project.ecosystems = ['npm'];
  manifest.options.nativeProjection = 'layout';
  manifest.policy = permissive;
  await writeManifestFile(paths.manifest, manifest);
  return root;
}

const add = (root: string, spec: string) =>
  addPackage({
    root,
    spec,
    ecosystem: 'npm',
    registryOptions: { transport: new NpmRegistryFixture(registry()) },
  });

describe('adding a package that makes a name two versions', () => {
  it('leaves nothing installed under a key the lock no longer has', async () => {
    const root = await project();
    const paths = projectPaths(root);
    await add(root, 'string-width@4.2.3');
    expect(
      Object.keys((await readLockfile(paths.lock))!.packages).sort(),
    ).toEqual(['ansi-regex', 'string-width', 'strip-ansi']);

    // strip-ansi 7 is now direct, so the 6 string-width needs is a second
    // version, and so is the ansi-regex each of them needs: `ansi-regex` is
    // not a key of the lock any more.
    await add(root, 'strip-ansi@7.1.0');

    const lock = (await readLockfile(paths.lock))!;
    expect(Object.keys(lock.packages).sort()).toEqual([
      'ansi-regex.5.0.1',
      'ansi-regex.6.4.0',
      'string-width',
      'strip-ansi',
      'strip-ansi.6.0.1',
    ]);
    const state = (await readProjectState(paths.projectState))!;
    expect(Object.keys(state.packages).sort()).toEqual(
      Object.keys(lock.packages).sort(),
    );
    // And `opm list` does not report a copy that is not in the lock as installed.
    const listed = await listInstalled(root);
    expect(listed.map((item) => item.alias).sort()).toEqual(
      Object.keys(lock.packages).sort(),
    );
    expect(listed.every((item) => item.installed)).toBe(true);
    // The tree on disk is the lock's.
    expect(
      JSON.parse(
        await readFile(
          join(
            root,
            'node_modules',
            'string-width',
            'node_modules',
            'strip-ansi',
            'package.json',
          ),
          'utf8',
        ),
      ).version,
    ).toBe('6.0.1');
  });
});
