import { describe, expect, it } from 'vitest';
import { configureDefaultAdapters } from '@openpacker/adapters-default';
import type { PolicyInput } from '@openpacker/contracts';
import { direct, lockOf, permissive } from './closure-support.js';
import { OLD } from './npm-registry-fixture.js';

configureDefaultAdapters();

/**
 * What the gates look at when a dependency is an alias (ADR 0054): the real
 * package, whatever it is installed as; and what the walk leaves alone because
 * the package carries it.
 */

describe('policy applies to the real package, not to its alias', () => {
  const hoursAgo = (hours: number) =>
    new Date(Date.now() - hours * 3_600_000).toISOString();
  const window: PolicyInput = { ...permissive, minimumReleaseAgeMinutes: 1440 };

  it('passes over a release inside the minimum age for the previous one in range', async () => {
    const { lock } = await lockOf(
      [
        {
          name: 'app',
          versions: { '1.0.0': { dependencies: { x: 'npm:fresh@^1' } } },
        },
        {
          name: 'fresh',
          versions: { '1.0.0': {}, '1.1.0': {} },
          time: { '1.0.0': OLD, '1.1.0': hoursAgo(2) },
          modified: hoursAgo(2),
        },
      ],
      direct('app', '1.0.0'),
      window,
    );
    expect(lock.packages.fresh?.purl).toBe('pkg:npm/fresh@1.0.0');
  });

  it('says what the policy set aside when an alias asks for exactly a release inside the window', async () => {
    await expect(
      lockOf(
        [
          {
            name: 'app',
            versions: { '1.0.0': { dependencies: { x: 'npm:fresh@1.1.0' } } },
          },
          {
            name: 'fresh',
            versions: { '1.1.0': {} },
            time: { '1.1.0': hoursAgo(2) },
            modified: hoursAgo(2),
          },
        ],
        direct('app', '1.0.0'),
        window,
      ),
    ).rejects.toMatchObject({
      code: 'UNRESOLVABLE',
      message: expect.stringMatching(
        /pkg:npm\/app@1\.0\.0 requires pkg:npm\/fresh 1\.1\.0 \(as x\), and no such release can be installed.*What the policy set aside:\n  - pkg:npm\/fresh@1\.1\.0: published inside the 1440-minute minimum release age \(required by pkg:npm\/app@1\.0\.0\)/su,
      ),
    });
  });

  it('refuses a target whose publish time nobody will give, naming the package, the dependent and the alias', async () => {
    await expect(
      lockOf(
        [
          {
            name: 'app',
            versions: { '1.0.0': { dependencies: { x: 'npm:fresh@1.1.0' } } },
          },
          {
            name: 'fresh',
            versions: { '1.1.0': {} },
            modified: hoursAgo(2),
          },
        ],
        direct('app', '1.0.0'),
        window,
        { serveFull: false },
      ),
    ).rejects.toMatchObject({
      code: 'POLICY_INDETERMINATE',
      message: expect.stringContaining(
        'pkg:npm/fresh@1.1.0 is required by pkg:npm/app@1.0.0 as x',
      ),
    });
  });
});

describe('a dependency the package bundles', () => {
  it('is not resolved, and not asked for', async () => {
    const { lock, fixture } = await lockOf(
      [
        {
          name: 'outer',
          versions: {
            '1.0.0': {
              dependencies: {
                inner: '^1',
                'inner-cjs': 'npm:inner@^1',
                free: '^1',
              },
              bundleDependencies: ['inner', 'inner-cjs'],
            },
          },
        },
        { name: 'free', versions: { '1.0.0': {} } },
        // `inner` is not in the registry at all: a walk that asked for it fails.
      ],
      direct('outer', '1.0.0'),
    );
    expect(Object.keys(lock.packages).sort()).toEqual(['free', 'outer']);
    expect(fixture.packumentRequests('inner')).toBe(0);
    expect(lock.packages.outer?.aliases).toBeUndefined();
  });
});
