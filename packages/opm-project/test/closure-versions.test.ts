import { execFileSync } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { configureDefaultAdapters } from '@openpacker/adapters-default';
import {
  projectPaths,
  readLockfile,
  removePackage,
  resolveGraph,
  solveGraph,
  writeLockfile,
  writeManifestFile,
} from '../src/index.js';
import { installAndLayout, lockOf } from './closure-support.js';
import {
  NpmRegistryFixture,
  type FixturePackage,
} from './npm-registry-fixture.js';

configureDefaultAdapters();

/**
 * A package at two versions in one project (ADR 0054): `opm add tinybench`
 * next to `vitest@4.1.9`, which needs `tinybench@^2.9.0`.
 */

const vitestAndTinybench = (): FixturePackage[] => [
  {
    name: 'vitest',
    versions: {
      '4.1.9': {
        dependencies: { tinybench: '^2.9.0' },
        files: {
          'index.js':
            "module.exports = { tinybench: require('tinybench').version };\n",
        },
      },
    },
  },
  {
    name: 'tinybench',
    versions: { '2.9.0': { files: {} }, '6.2.2': { files: {} } },
  },
];

const both = {
  vitest: { alias: 'vitest', purl: 'pkg:npm/vitest', version: '4.1.9' },
  tinybench: {
    alias: 'tinybench',
    purl: 'pkg:npm/tinybench',
    version: '6.2.2',
  },
};

describe('tinybench next to vitest', () => {
  it('locks both, the direct one under its alias', async () => {
    const { lock } = await lockOf(vitestAndTinybench(), both);
    expect(Object.keys(lock.packages).sort()).toEqual([
      'tinybench',
      'tinybench.2.9.0',
      'vitest',
    ]);
    expect(lock.packages.tinybench).toMatchObject({
      purl: 'pkg:npm/tinybench@6.2.2',
      reason: 'direct',
    });
    expect(lock.packages['tinybench.2.9.0']).toMatchObject({
      purl: 'pkg:npm/tinybench@2.9.0',
      reason: 'transitive',
    });
    expect(lock.packages.vitest?.dependencies).toEqual(['tinybench.2.9.0']);
  });

  it('lays out the direct one at the root and the other beside vitest, and Node finds each', async () => {
    const { lock, root, manifest } = await lockOf(vitestAndTinybench(), both);
    await installAndLayout({ root, manifest, lock });
    const version = (...path: string[]) =>
      execFileSync(
        process.execPath,
        [
          '-e',
          `console.log(require(${JSON.stringify(join(root, ...path))}).version)`,
        ],
        { encoding: 'utf8' },
      ).trim();
    expect(version('node_modules', 'tinybench')).toBe('6.2.2');
    expect(
      JSON.parse(
        await readFile(
          join(
            root,
            'node_modules',
            'vitest',
            'node_modules',
            'tinybench',
            'package.json',
          ),
          'utf8',
        ),
      ).version,
    ).toBe('2.9.0');
    expect(
      execFileSync(
        process.execPath,
        ['-e', "console.log(JSON.stringify(require('vitest')))"],
        { cwd: root, encoding: 'utf8' },
      ).trim(),
    ).toBe(JSON.stringify({ tinybench: '2.9.0' }));
  });

  it('is one lock whichever is added first', async () => {
    const { serializeLockfile } = await import('../src/index.js');
    const first = await lockOf(vitestAndTinybench(), both);
    const second = await lockOf(vitestAndTinybench(), {
      tinybench: both.tinybench,
      vitest: both.vitest,
    });
    expect(serializeLockfile(second.lock)).toBe(serializeLockfile(first.lock));
  });
});

describe('removing from a project that holds a package twice', () => {
  const setup = async () => {
    const made = await lockOf(vitestAndTinybench(), both);
    const paths = projectPaths(made.root);
    await writeManifestFile(paths.manifest, made.manifest);
    await writeLockfile(paths.lock, made.lock);
    await installAndLayout(made);
    return { ...made, paths };
  };

  it('remove takes the version only its dependent needed, and keeps the other', async () => {
    const { root, paths } = await setup();
    await removePackage({ root, alias: 'vitest' });
    const lock = await readLockfile(paths.lock);
    expect(Object.keys(lock!.packages)).toEqual(['tinybench']);
    expect(
      (await lstat(join(root, 'node_modules', 'tinybench'))).isDirectory(),
    ).toBe(true);
    await expect(
      lstat(join(root, 'node_modules', 'vitest')),
    ).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('remove of the direct one leaves the version vitest needs, and the layout moves it to the root', async () => {
    const { root, paths } = await setup();
    await removePackage({ root, alias: 'tinybench' });
    const lock = await readLockfile(paths.lock);
    expect(Object.keys(lock!.packages).sort()).toEqual([
      'tinybench.2.9.0',
      'vitest',
    ]);
    // Nothing else holds the name any more, so it is no longer nested.
    expect(
      JSON.parse(
        await readFile(
          join(root, 'node_modules', 'tinybench', 'package.json'),
          'utf8',
        ),
      ).version,
    ).toBe('2.9.0');
    await expect(
      lstat(join(root, 'node_modules', 'vitest', 'node_modules')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('an engine refusal that was not one', () => {
  it('locks a closure whose newest release depends on an older release of itself and on one that cannot be installed', async () => {
    // p0@3 needs p0 in [1, 3), p0@2 needs a p4 that does not exist, and p4 asks
    // for any p0. The engine alone said the project was unsatisfiable, though
    // p0@1 alone satisfies it; candidates that can never be installed are
    // taken out before it is asked.
    const registry: FixturePackage[] = [
      { name: 'root', versions: { '1.0.0': { dependencies: { p4: '^1' } } } },
      {
        name: 'p0',
        versions: {
          '2.0.0': { dependencies: { p4: '^3' } },
          '1.0.0': {},
          '3.0.0': { dependencies: { p0: '>=1.0.0 <3.0.0' } },
        },
      },
      { name: 'p4', versions: { '1.0.0': { dependencies: { p0: '*' } } } },
    ];
    const graph = await resolveGraph({
      roots: [{ purl: 'pkg:npm/root' }],
      options: { transport: new NpmRegistryFixture(registry) },
    });
    const solved = await solveGraph({
      graph,
      rootRequirements: [{ purl: 'pkg:npm/root' }],
    });
    expect(
      solved.selected.map((item) => item.identity.exactPurl).sort(),
    ).toEqual(['pkg:npm/p0@1.0.0', 'pkg:npm/p4@1.0.0', 'pkg:npm/root@1.0.0']);
  });

  it('holds two releases of a name when one requirement accepts both of them', async () => {
    // p0@1 and p0@2 are both needed (each by a dependent that accepts only
    // it), and a third dependent accepts either: the engine's own proof check
    // refused this until its checker named the witness the way the solve does.
    const registry: FixturePackage[] = [
      {
        name: 'root',
        versions: { '1.0.0': { dependencies: { a: '*', b: '*', c: '*' } } },
      },
      {
        name: 'a',
        versions: { '1.0.0': { dependencies: { shared: '1.0.0' } } },
      },
      {
        name: 'b',
        versions: { '1.0.0': { dependencies: { shared: '2.0.0' } } },
      },
      {
        name: 'c',
        versions: { '1.0.0': { dependencies: { shared: '>=1.0.0 <3.0.0' } } },
      },
      { name: 'shared', versions: { '1.0.0': {}, '2.0.0': {} } },
    ];
    const graph = await resolveGraph({
      roots: [{ purl: 'pkg:npm/root' }],
      options: { transport: new NpmRegistryFixture(registry) },
    });
    const solved = await solveGraph({
      graph,
      rootRequirements: [{ purl: 'pkg:npm/root' }],
    });
    const sharedVersions = solved.selected
      .filter((item) => item.identity.canonicalPurl === 'pkg:npm/shared')
      .map((item) => item.nativeVersion)
      .sort();
    expect(sharedVersions).toEqual(['1.0.0', '2.0.0']);
    // `c` takes the newest it accepts.
    const c = solved.selected.find((item) => item.identity.name === 'c')!;
    const edge = solved.dependencyEdges.find(
      (item) => item.fromNodeId === c.nodeId,
    )!;
    expect(
      solved.selected.find((item) => item.nodeId === edge.toNodeId)
        ?.nativeVersion,
    ).toBe('2.0.0');
  });
});
