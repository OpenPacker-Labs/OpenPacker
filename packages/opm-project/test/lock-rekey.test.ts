import { describe, expect, it } from 'vitest';
import { configureDefaultAdapters } from '@openpacker/adapters-default';
import { canonicalize } from '@openpacker/canonical';
import {
  listInstalled,
  parseLockfile,
  projectPaths,
  readLockfile,
  readManifestFile,
  readProjectState,
  removePackage,
  resolveManifestToLock,
  serializeLockfile,
  writeLockfile,
  writeManifestFile,
  type OpmLockfile,
} from '../src/index.js';
import { applyKeys, rekeyTransitive } from '../src/lock-rekey.js';
import { installAndLayout, lockOf } from './closure-support.js';
import {
  NpmRegistryFixture,
  type FixturePackage,
} from './npm-registry-fixture.js';

configureDefaultAdapters();

/**
 * Keys after a removal (ADR 0054). `opm install` compares the lock with a
 * fresh resolve of the manifest, so a lock `opm remove` leaves has to be the
 * lock a resolve of the smaller manifest writes, keys included.
 */

const registry = (): FixturePackage[] => [
  {
    name: 'vitest',
    versions: {
      '4.1.9': { dependencies: { tinybench: '^2.9.0' }, files: {} },
    },
  },
  {
    name: 'tinybench',
    versions: { '2.9.0': { files: {} }, '6.2.2': { files: {} } },
  },
];

const requirement = (name: string, version: string, installName?: string) => ({
  alias: installName ?? name,
  purl: `pkg:npm/${name}`,
  version,
  ...(!(installName === undefined) && { installName }),
});

const same = (left: OpmLockfile, right: OpmLockfile): boolean =>
  canonicalize(JSON.parse(serializeLockfile(left))) ===
  canonicalize(JSON.parse(serializeLockfile(right)));

/** The keys, the edges and the names of a lock. */
const keysAndEdges = (lock: OpmLockfile) =>
  Object.fromEntries(
    Object.entries(lock.packages).map(([key, pkg]) => [
      key,
      [
        pkg.purl,
        pkg.reason,
        pkg.dependencies ?? [],
        pkg.aliases ?? {},
        pkg.installName ?? null,
      ],
    ]),
  );

const freshLock = async (
  root: string,
  registryOf: FixturePackage[],
): Promise<OpmLockfile> =>
  resolveManifestToLock({
    root,
    manifest: await readManifestFile(projectPaths(root).manifest),
    offline: false,
    registryOptions: { transport: new NpmRegistryFixture(registryOf) },
  });

describe('the lock opm remove leaves', () => {
  it('is the lock a resolve of the smaller manifest writes, when a name is left at one version', async () => {
    const made = await lockOf(registry(), {
      vitest: requirement('vitest', '4.1.9'),
      tinybench: requirement('tinybench', '6.2.2'),
    });
    const paths = projectPaths(made.root);
    await writeManifestFile(paths.manifest, made.manifest);
    await writeLockfile(paths.lock, made.lock);
    await installAndLayout(made);
    expect(Object.keys(made.lock.packages).sort()).toEqual([
      'tinybench',
      'tinybench.2.9.0',
      'vitest',
    ]);

    const { state } = await removePackage({
      root: made.root,
      alias: 'tinybench',
    });

    const lock = (await readLockfile(paths.lock))!;
    expect(Object.keys(lock.packages).sort()).toEqual(['tinybench', 'vitest']);
    // The key `tinybench` was the removed 6.2.2's and is now 2.9.0's: the
    // installed record under it is 2.9.0's, not the old one left behind.
    expect(lock.packages.tinybench?.purl).toBe('pkg:npm/tinybench@2.9.0');
    expect(state.packages.tinybench?.digest).toBe(
      lock.packages.tinybench?.digest,
    );
    expect(Object.keys(state.packages).sort()).toEqual(['tinybench', 'vitest']);
    expect(
      (await listInstalled(made.root)).map((item) => [
        item.alias,
        item.installed,
      ]),
    ).toEqual([
      ['tinybench', true],
      ['vitest', true],
    ]);
    expect((await readProjectState(paths.projectState))?.packages).toEqual(
      state.packages,
    );
    expect(same(lock, await freshLock(made.root, registry()))).toBe(true);
  });

  it('is the lock a resolve writes, when a direct alias stays as a dependency', async () => {
    const dependents: FixturePackage[] = [
      {
        name: 'cliui',
        versions: { '8.0.2': { dependencies: { 'string-width': '^4.2.0' } } },
      },
      { name: 'string-width', versions: { '4.2.3': { files: {} } } },
    ];
    const made = await lockOf(dependents, {
      cliui: requirement('cliui', '8.0.2'),
      swc: {
        ...requirement('string-width', '4.2.3', 'string-width-cjs'),
        alias: 'swc',
      },
    });
    const paths = projectPaths(made.root);
    await writeManifestFile(paths.manifest, made.manifest);
    await writeLockfile(paths.lock, made.lock);
    await installAndLayout(made);

    await removePackage({ root: made.root, alias: 'swc' });

    const lock = (await readLockfile(paths.lock))!;
    // The label the project gave it is gone with the requirement.
    expect(Object.keys(lock.packages).sort()).toEqual([
      'cliui',
      'string-width',
    ]);
    expect(lock.packages.cliui?.dependencies).toEqual(['string-width']);
    // What a resolve writes for the smaller manifest: the same keys, edges and
    // names. (The facts captured while it was direct stay: its trust tier was
    // read at depth 0, a resolve reads a dependency's at depth 1.)
    const fresh = await freshLock(made.root, dependents);
    expect(keysAndEdges(lock)).toEqual(keysAndEdges(fresh));
    expect(
      Object.keys(
        (await readProjectState(paths.projectState))!.packages,
      ).sort(),
    ).toEqual(['cliui', 'string-width']);
  });
});

describe('rekeyTransitive', () => {
  it('leaves a direct requirement under its label, and renames only dependencies', async () => {
    const made = await lockOf(registry(), {
      vitest: requirement('vitest', '4.1.9'),
      // A label that is not the package's name.
      tb: { alias: 'tb', purl: 'pkg:npm/tinybench', version: '6.2.2' },
    });
    expect(Object.keys(made.lock.packages).sort()).toEqual([
      'tb',
      'tinybench.2.9.0',
      'vitest',
    ]);
    // As if its requirement had been removed (and the entries are not the
    // frozen ones a resolve binds to their bytes).
    const lock = parseLockfile(serializeLockfile(made.lock));
    delete lock.packages.tb;
    const renamed = rekeyTransitive(lock);
    expect([...renamed]).toEqual([['tinybench.2.9.0', 'tinybench']]);
    applyKeys(lock, renamed);
    expect(lock.packages.tinybench).toMatchObject({ alias: 'tinybench' });
    expect(lock.packages.vitest?.dependencies).toEqual(['tinybench']);
    expect(Object.keys(lock.packages).sort()).toEqual(['tinybench', 'vitest']);
    // The entries a resolve bound to their bytes are left alone.
    expect(made.lock.packages.vitest?.dependencies).toEqual([
      'tinybench.2.9.0',
    ]);
  });

  it('does nothing to a lock whose keys are already right', async () => {
    const made = await lockOf(registry(), {
      vitest: requirement('vitest', '4.1.9'),
      tinybench: requirement('tinybench', '6.2.2'),
    });
    expect(rekeyTransitive(made.lock).size).toBe(0);
  });
});
