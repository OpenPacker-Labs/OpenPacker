import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PolicyInput } from '@openpacker/contracts';
import { resolveManifestToLock, type OpmManifest } from '../src/index.js';
import {
  NpmRegistryFixture,
  type FixturePackage,
} from './npm-registry-fixture.js';

/**
 * A package needed at two versions (ADR 0054): when one release suits every
 * dependent the lock holds one, when none does it holds both and says which
 * dependent uses which, and where a peer dependency would need two it still
 * names who requires what. (Before ADR 0054 each of these was a refusal.)
 */

describe('one version per package, and what happens when that cannot hold', () => {
  const permissive: PolicyInput = {
    allowYanked: false,
    allowQuarantined: false,
    semanticLossMaximum: 'warning',
    requiredEvidence: [],
  };
  const manifestOf = (packages: OpmManifest['packages']): OpmManifest => ({
    project: { name: 'closure', ecosystems: ['npm'] },
    packages,
    options: { offline: false, layout: 'opm' },
    policy: permissive,
  });
  const lockOf = async (
    registry: FixturePackage[],
    packages: OpmManifest['packages'],
  ) => {
    const root = await mkdtemp(join(tmpdir(), 'opm-closure-'));
    try {
      return await resolveManifestToLock({
        root,
        manifest: manifestOf(packages),
        offline: false,
        registryOptions: { transport: new NpmRegistryFixture(registry) },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  };

  it('picks the version both dependents accept, not the newest of either', async () => {
    // `left` would take 1.3.0; `right` takes only 1.2.x. Both ranges reached
    // the solver as "any version" until the adapter attached them, so it took
    // 1.3.0 for both and the lock paired `right` with a version it rejects.
    const lock = await lockOf(
      [
        {
          name: 'app',
          versions: { '1.0.0': { dependencies: { left: '^1', right: '^1' } } },
        },
        {
          name: 'left',
          versions: { '1.0.0': { dependencies: { shared: '^1.0.0' } } },
        },
        {
          name: 'right',
          versions: { '1.0.0': { dependencies: { shared: '~1.2.0' } } },
        },
        {
          name: 'shared',
          versions: { '1.0.0': {}, '1.2.0': {}, '1.2.5': {}, '1.3.0': {} },
        },
      ],
      { app: { alias: 'app', purl: 'pkg:npm/app', version: '1.0.0' } },
    );
    expect(lock.packages.shared?.purl).toBe('pkg:npm/shared@1.2.5');
  });

  it('keeps both versions when no single release suits every dependent', async () => {
    // app@2 needs shared 2 and `right` cannot take it; app@1 would have agreed
    // with it. The lock does not back out of the newer app: it holds both
    // releases of shared, as npm nests them, and says which dependent uses which.
    const lock = await lockOf(
      [
        {
          name: 'root',
          versions: {
            '1.0.0': { dependencies: { app: '*', right: '^1' } },
          },
        },
        {
          name: 'app',
          versions: {
            '1.0.0': { dependencies: { shared: '^1' } },
            '2.0.0': { dependencies: { shared: '^2' } },
          },
        },
        {
          name: 'right',
          versions: { '1.0.0': { dependencies: { shared: '^1' } } },
        },
        { name: 'shared', versions: { '1.4.0': {}, '2.0.0': {} } },
      ],
      { root: { alias: 'root', purl: 'pkg:npm/root', version: '1.0.0' } },
    );
    expect(Object.keys(lock.packages).sort()).toEqual([
      'app',
      'right',
      'root',
      'shared.1.4.0',
      'shared.2.0.0',
    ]);
    expect(lock.packages.app?.purl).toBe('pkg:npm/app@2.0.0');
    expect(lock.packages.app?.dependencies).toEqual(['shared.2.0.0']);
    expect(lock.packages.right?.dependencies).toEqual(['shared.1.4.0']);
    expect(lock.packages['shared.1.4.0']?.reason).toBe('transitive');
  });

  it('keeps a direct pin and the other version a dependent needs', async () => {
    // npm would nest shared@1 under app and keep shared@2 at the top, and so
    // does the lock: the direct requirement keeps its manifest alias, and the
    // version `app` needs is an entry of its own.
    const lock = await lockOf(
      [
        {
          name: 'app',
          versions: { '1.0.0': { dependencies: { shared: '^1' } } },
        },
        { name: 'shared', versions: { '1.4.0': {}, '2.0.0': {} } },
      ],
      {
        app: { alias: 'app', purl: 'pkg:npm/app', version: '1.0.0' },
        shared: { alias: 'shared', purl: 'pkg:npm/shared', version: '2.0.0' },
      },
    );
    expect(lock.packages.shared).toMatchObject({
      purl: 'pkg:npm/shared@2.0.0',
      reason: 'direct',
    });
    expect(lock.packages['shared.1.4.0']).toMatchObject({
      purl: 'pkg:npm/shared@1.4.0',
      reason: 'transitive',
    });
    expect(lock.packages.app?.dependencies).toEqual(['shared.1.4.0']);
  });

  it('still says who cannot agree when a peer dependency would need two releases', async () => {
    // A peer has to resolve to the instance its dependent's parent sees, so it
    // is not split across versions the way an ordinary dependency is.
    await expect(
      lockOf(
        [
          {
            name: 'root',
            versions: {
              '1.0.0': { dependencies: { plugin: '^1', host: '^2' } },
            },
          },
          {
            name: 'plugin',
            versions: { '1.0.0': { peerDependencies: { host: '^1' } } },
          },
          { name: 'host', versions: { '1.4.0': {}, '2.0.0': {} } },
        ],
        { root: { alias: 'root', purl: 'pkg:npm/root', version: '1.0.0' } },
      ),
    ).rejects.toMatchObject({
      code: 'UNRESOLVABLE',
      message: expect.stringMatching(
        /pkg:npm\/host is required as a peer dependency.*pkg:npm\/plugin@1\.0\.0 requires \^1/su,
      ),
    });
  });

  it('says who required a range nothing published satisfies', async () => {
    await expect(
      lockOf(
        [
          {
            name: 'app',
            versions: { '1.0.0': { dependencies: { shared: '^3' } } },
          },
          { name: 'shared', versions: { '1.4.0': {}, '2.0.0': {} } },
        ],
        { app: { alias: 'app', purl: 'pkg:npm/app', version: '1.0.0' } },
      ),
    ).rejects.toMatchObject({
      code: 'UNRESOLVABLE',
      message: expect.stringMatching(
        /pkg:npm\/shared: no published version satisfies \^3 \(required by pkg:npm\/app@1\.0\.0\)/u,
      ),
    });
  });
});
