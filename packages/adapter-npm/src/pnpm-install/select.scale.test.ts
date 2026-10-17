/**
 * The selection's cost grows with the lock, not with its square.
 *
 * A chain `p0 <- p1 <- ... <- pN`, every link optional and `p0` for another
 * platform, drops one more instance per step of the closure. Rescanning every
 * instance until nothing changes took N passes over N instances (8,000 of them
 * in 9.9 s, a 16,000 one through `opm ci --plan` in 67 s); a lock within the
 * reader's bounds must not cost that.
 */

import type { NativeTarget } from '@openpacker/adapter-core';
import { describe, expect, it } from 'vitest';
import { readPnpmLock } from '../pnpm-lock/index.js';
import { LOCK, pkg } from './lock-support.js';
import {
  buildPnpmModel,
  type PnpmInstance,
  type PnpmModel,
  type PnpmTop,
} from './model.js';
import { selectInstances } from './select.js';

const LINUX: NativeTarget = { os: 'linux', architecture: 'x64', libc: 'glibc' };

/** The `packages` entries a generated chain reuses: one for darwin only, one for anywhere. */
function templates() {
  const { lock } = readPnpmLock(
    LOCK(`importers:

  .:
    optionalDependencies:
      darwin-only:
        specifier: 1.0.0
        version: 1.0.0
      anywhere:
        specifier: 1.0.0
        version: 1.0.0

packages:

${pkg('darwin-only@1.0.0', '    os: [darwin]\n')}
${pkg('anywhere@1.0.0')}

snapshots:

  darwin-only@1.0.0:
    optional: true
  anywhere@1.0.0:
    optional: true
`),
  );
  const model = buildPnpmModel(lock);
  return {
    lock,
    darwin: model.instances.get('darwin-only@1.0.0')!.pkg,
    anywhere: model.instances.get('anywhere@1.0.0')!.pkg,
  };
}

/** `p0` (darwin) needed outright by `p1`, ..., by `p<length-1>`, which the project needs optionally. */
function chain(length: number): PnpmModel {
  const { lock, darwin, anywhere } = templates();
  const instances = new Map<string, PnpmInstance>();
  for (let index = 0; index < length; index += 1) {
    const key = `p${index}@1.0.0`;
    instances.set(key, {
      key,
      packageKey: key,
      name: `p${index}`,
      version: '1.0.0',
      pkg: index === 0 ? darwin : anywhere,
      optional: true,
      edges:
        index === 0
          ? []
          : [
              {
                as: `p${index - 1}`,
                to: `p${index - 1}@1.0.0`,
                optional: false,
              },
            ],
      links: [],
    });
  }
  const top: PnpmTop = {
    id: '.',
    dir: '',
    edges: [
      {
        kind: 'dep',
        as: `p${length - 1}`,
        list: 'optionalDependencies',
        specifier: '1.0.0',
        to: `p${length - 1}@1.0.0`,
      },
    ],
  };
  return { lock, instances, tops: new Map([['.', top]]) };
}

describe('the selection on a long chain of optional packages', () => {
  it('drops a chain of 20,000 in time linear in the lock', () => {
    const length = 20_000;
    const model = chain(length);
    const meter = { visits: 0 };
    const started = performance.now();
    const selection = selectInstances(
      { model, tops: new Set(['.']), omit: new Set(), targets: [LINUX] },
      meter,
    );
    const elapsed = performance.now() - started;

    expect(selection.included.size).toBe(0);
    expect(selection.refused).toEqual([]);
    expect(selection.skipped).toHaveLength(length);
    expect(selection.skipped.find((skip) => skip.name === 'p0')).toMatchObject({
      kind: 'platform',
    });
    expect(selection.skipped.find((skip) => skip.name === 'p7')).toMatchObject({
      kind: 'orphaned',
      reason: 'needs p6@1.0.0, which this machine does not install',
    });
    // A generous bound on a shared machine: the quadratic closure took minutes.
    expect(elapsed).toBeLessThan(5_000);
    // Every instance and every edge is looked at a bounded number of times:
    // three walks, the platform pass, the reverse edges and the closure.
    const size = model.instances.size + (length - 1) + 1;
    expect(meter.visits).toBeGreaterThan(0);
    expect(meter.visits).toBeLessThanOrEqual(8 * size);
  }, 120_000);

  it('counts no more work for a chain twice as long than twice the work', () => {
    const work = (length: number) => {
      const meter = { visits: 0 };
      selectInstances(
        {
          model: chain(length),
          tops: new Set(['.']),
          omit: new Set(),
          targets: [LINUX],
        },
        meter,
      );
      return meter.visits;
    };
    const small = work(2_000);
    expect(small).toBeGreaterThan(0);
    expect(work(4_000)).toBeLessThanOrEqual(2 * small + 16);
  }, 120_000);
});
