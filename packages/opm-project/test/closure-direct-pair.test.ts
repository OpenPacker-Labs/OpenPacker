import { execFileSync } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { configureDefaultAdapters } from '@openpacker/adapters-default';
import {
  listInstalled,
  projectPaths,
  readLockfile,
  removePackage,
  serializeLockfile,
  writeLockfile,
  writeManifestFile,
  type OpmManifest,
} from '../src/index.js';
import { installAndLayout, lockOf } from './closure-support.js';
import type { FixturePackage } from './npm-registry-fixture.js';

configureDefaultAdapters();

/**
 * One release asked for directly under two names (ADR 0054): `string-width`
 * and `string-width-cjs@npm:string-width@4.2.3`. They are two directories with
 * one package in each, so each needs the dependency the release declares, and
 * neither can lean on the other being in the lock.
 */

const registry = (): FixturePackage[] => [
  {
    name: 'string-width',
    versions: {
      '4.2.3': {
        dependencies: { 'strip-ansi': '^6.0.1' },
        files: {
          'index.js':
            "module.exports = { version: '4.2.3', inner: require('strip-ansi').version };\n",
        },
      },
    },
  },
  {
    name: 'strip-ansi',
    versions: { '6.0.1': { files: {} }, '7.1.0': { files: {} } },
  },
];

const requirement = (
  alias: string,
  name: string,
  version: string,
  installName?: string,
): OpmManifest['packages'][string] => ({
  alias,
  purl: `pkg:npm/${name}`,
  version,
  ...(!(installName === undefined) && { installName }),
});

/** strip-ansi@7 at the root, so a dependent that needs 6 must nest its own. */
const directs = (): OpmManifest['packages'] => ({
  'strip-ansi': requirement('strip-ansi', 'strip-ansi', '7.1.0'),
  'string-width': requirement('string-width', 'string-width', '4.2.3'),
  'string-width-cjs': requirement(
    'string-width-cjs',
    'string-width',
    '4.2.3',
    'string-width-cjs',
  ),
});

const innerVersion = (cwd: string, name: string): string =>
  (
    JSON.parse(
      execFileSync(
        process.execPath,
        ['-e', `console.log(JSON.stringify(require('${name}')))`],
        { cwd, encoding: 'utf8' },
      ),
    ) as { inner: string }
  ).inner;

describe('two direct requirements of one release under two install names', () => {
  it('gives each of them the dependencies the release declares', async () => {
    const { lock } = await lockOf(registry(), directs());
    expect(Object.keys(lock.packages).sort()).toEqual([
      'string-width',
      'string-width-cjs',
      'strip-ansi',
      'strip-ansi.6.0.1',
    ]);
    expect(lock.packages['string-width']?.dependencies).toEqual([
      'strip-ansi.6.0.1',
    ]);
    expect(lock.packages['string-width-cjs']).toMatchObject({
      reason: 'direct',
      installName: 'string-width-cjs',
      dependencies: ['strip-ansi.6.0.1'],
    });
  });

  it('installs each directory with its own strip-ansi, and both run', async () => {
    const made = await lockOf(registry(), directs());
    await installAndLayout(made);
    // The root holds strip-ansi@7 (a direct requirement), so each copy of
    // string-width brings the 6 it was released against.
    expect(innerVersion(made.root, 'string-width')).toBe('6.0.1');
    expect(innerVersion(made.root, 'string-width-cjs')).toBe('6.0.1');
    for (const directory of ['string-width', 'string-width-cjs'])
      expect(
        (
          await lstat(
            join(
              made.root,
              'node_modules',
              directory,
              'node_modules',
              'strip-ansi',
            ),
          )
        ).isDirectory(),
      ).toBe(true);
  });

  it('is the same lock whichever of the two sorts first', async () => {
    const first = await lockOf(registry(), directs());
    const renamed = directs();
    // The same two requirements, the plain one listed under a later label.
    const plain = renamed['string-width']!;
    delete renamed['string-width'];
    renamed['string-width-plain'] = { ...plain, alias: 'string-width-plain' };
    const second = await lockOf(registry(), renamed);
    expect(second.lock.packages['string-width-cjs']?.dependencies).toEqual(
      first.lock.packages['string-width-cjs']?.dependencies,
    );
    expect(second.lock.packages['string-width-plain']?.dependencies).toEqual(
      first.lock.packages['string-width']?.dependencies,
    );
    // And a resolve of one project twice is one lock.
    const again = await lockOf(registry(), directs());
    expect(serializeLockfile(again.lock)).toBe(serializeLockfile(first.lock));
  });

  it('keeps the other one whole when the first is removed', async () => {
    const made = await lockOf(registry(), directs());
    const paths = projectPaths(made.root);
    await writeManifestFile(paths.manifest, made.manifest);
    await writeLockfile(paths.lock, made.lock);
    await installAndLayout(made);

    await removePackage({ root: made.root, alias: 'string-width' });

    const lock = await readLockfile(paths.lock);
    expect(Object.keys(lock!.packages).sort()).toEqual([
      'string-width-cjs',
      'strip-ansi',
      'strip-ansi.6.0.1',
    ]);
    expect(lock!.packages['string-width-cjs']?.dependencies).toEqual([
      'strip-ansi.6.0.1',
    ]);
    // What is left still resolves the strip-ansi it was released against.
    expect(innerVersion(made.root, 'string-width-cjs')).toBe('6.0.1');
    await expect(
      lstat(join(made.root, 'node_modules', 'string-width')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('removing a direct alias whose release another package still needs', () => {
  const cliui = (): FixturePackage[] => [
    {
      name: 'cliui',
      versions: {
        '8.0.2': {
          dependencies: { 'string-width': '^4.2.0' },
        },
      },
    },
    ...registry(),
  ];

  it('leaves it as a dependency only, with no install name nothing asks for', async () => {
    const made = await lockOf(cliui(), {
      cliui: requirement('cliui', 'cliui', '8.0.2'),
      swc: requirement('swc', 'string-width', '4.2.3', 'string-width-cjs'),
    });
    const paths = projectPaths(made.root);
    await writeManifestFile(paths.manifest, made.manifest);
    await writeLockfile(paths.lock, made.lock);
    await installAndLayout(made);
    expect(made.lock.packages.swc?.installName).toBe('string-width-cjs');

    await removePackage({ root: made.root, alias: 'swc' });

    const lock = await readLockfile(paths.lock);
    // It stays, as a dependency of cliui: under the key a dependency has, and
    // without an install name that nothing asks for.
    expect(Object.keys(lock!.packages).sort()).toEqual([
      'cliui',
      'string-width',
      'strip-ansi',
    ]);
    expect(lock!.packages['string-width']).toMatchObject({
      reason: 'transitive',
    });
    expect(lock!.packages['string-width']?.installName).toBeUndefined();
    const listed = await listInstalled(made.root);
    expect(
      listed.find((item) => item.alias === 'string-width')?.installedAs,
    ).toEqual([]);
    await expect(
      lstat(join(made.root, 'node_modules', 'string-width-cjs')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(
      (
        await lstat(join(made.root, 'node_modules', 'string-width'))
      ).isDirectory(),
    ).toBe(true);
  });
});
