import { describe, expect, it } from 'vitest';
import { configureDefaultAdapters } from '@openpacker/adapters-default';
import { direct, lockOf } from './closure-support.js';
import type { FixturePackage } from './npm-registry-fixture.js';

configureDefaultAdapters();

/**
 * A range with a prerelease in it, and a prerelease the solver's comparison form
 * admits that npm's own rule does not (ADR 0054). `^7.0.0-0` is
 * `>=7.0.0-0 <8.0.0-0` to npm and `>=7.0.0-0|<8.0.0` to the solver, which admits
 * `8.0.0-rc.6`; `*` is no prerelease at all. A selection that leaves an edge
 * unmet by npm's rule is not final: the edge is narrowed to the releases npm
 * accepts and the closure is solved again.
 */

describe('a prerelease the solver admits and the ecosystem does not', () => {
  it('keeps a release for the edge that wants a prerelease and another for one that wants any', async () => {
    const registry: FixturePackage[] = [
      {
        name: 'app',
        versions: {
          '1.0.0': { dependencies: { lib: '*', other: '*' } },
        },
      },
      {
        name: 'other',
        versions: { '1.0.0': { dependencies: { lib: '>=2.0.0-rc.0' } } },
      },
      { name: 'lib', versions: { '1.0.0': {}, '2.0.0-rc.1': {} } },
    ];
    const { lock } = await lockOf(registry, direct('app', '1.0.0'));
    expect(Object.keys(lock.packages).sort()).toEqual([
      'app',
      'lib.1.0.0',
      'lib.2.0.0-rc.1',
      'other',
    ]);
    expect(lock.packages.app?.dependencies).toEqual(['lib.1.0.0', 'other']);
    expect(lock.packages.other?.dependencies).toEqual(['lib.2.0.0-rc.1']);
  });

  it('settles on the one release that suits every peer of a babel-shaped closure', async () => {
    // @babel/plugin-syntax-bigint: peer @babel/core ^7.0.0-0. Its siblings
    // accept 8 as well, so 8.0.0-rc.6 is a candidate, and the solver prefers
    // the newest for all of them.
    const registry: FixturePackage[] = [
      {
        name: 'app',
        versions: { '1.0.0': { dependencies: { plugin: '*', preset: '*' } } },
      },
      {
        name: 'plugin',
        versions: { '7.8.3': { peerDependencies: { core: '^7.0.0-0' } } },
      },
      {
        name: 'preset',
        versions: {
          '7.0.0': { peerDependencies: { core: '^7.0.0-0 || ^8.0.0-0' } },
        },
      },
      {
        name: 'core',
        versions: { '7.5.0': {}, '8.0.0-rc.6': {} },
      },
    ];
    const { lock } = await lockOf(registry, direct('app', '1.0.0'));
    expect(Object.keys(lock.packages).sort()).toEqual([
      'app',
      'core',
      'plugin',
      'preset',
    ]);
    expect(lock.packages.core?.purl).toBe('pkg:npm/core@7.5.0');
    expect(lock.packages.plugin?.dependencies).toEqual(['core']);
    expect(lock.packages.preset?.dependencies).toEqual(['core']);
  });

  it('is the same lock the next time', async () => {
    const registry = (): FixturePackage[] => [
      {
        name: 'app',
        versions: { '1.0.0': { dependencies: { lib: '*', other: '*' } } },
      },
      {
        name: 'other',
        versions: { '1.0.0': { dependencies: { lib: '>=2.0.0-rc.0' } } },
      },
      { name: 'lib', versions: { '1.0.0': {}, '2.0.0-rc.1': {} } },
    ];
    const { serializeLockfile } = await import('../src/index.js');
    const first = await lockOf(registry(), direct('app', '1.0.0'));
    const second = await lockOf(registry(), direct('app', '1.0.0'));
    expect(serializeLockfile(second.lock)).toBe(serializeLockfile(first.lock));
  });
});
