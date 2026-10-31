import { describe, expect, it } from 'vitest';
import { buildOrder } from '../src/frozen-build-order.js';

/**
 * The order `opm ci` runs the approved install scripts in (ADR 0060 §7): a
 * package's after those of every approved package it depends on, resolved to
 * the place in the lock Node loads it from; the lock's order where nothing
 * says otherwise; and a cycle in the lock's order, reported.
 */

interface Place {
  path: string;
  name: string;
}

/** Places in the lock's order, what each depends on by name, and which run a script. */
function lock(
  places: readonly [path: string, depends: readonly string[]][],
  runs: readonly string[],
  extra: {
    links?: { path: string; target: string }[];
    members?: Record<string, readonly string[]>;
    stops?: readonly string[];
  } = {},
) {
  const packages: Place[] = places.map(([path]) => ({
    path,
    name: path.slice(path.lastIndexOf('node_modules/') + 13),
  }));
  const names = new Map<string, readonly string[]>([
    ...places,
    ...Object.entries(extra.members ?? {}),
  ]);
  const read: string[] = [];
  return {
    read,
    order: buildOrder({
      packages,
      runs: (pkg) => runs.includes(pkg.path),
      links: extra.links ?? [],
      stops: new Set(extra.stops ?? []),
      dependencyNames: async (dir) => {
        read.push(dir);
        return names.get(dir) ?? [];
      },
    }),
  };
}

const paths = (list: readonly Place[]) => list.map((pkg) => pkg.path);

describe('buildOrder', () => {
  it("keeps the lock's order where no package depends on another", async () => {
    const { order } = lock(
      [
        ['node_modules/a', []],
        ['node_modules/b', []],
        ['node_modules/c', []],
      ],
      ['node_modules/c', 'node_modules/a', 'node_modules/b'],
    );
    const result = await order;
    expect(paths(result.order)).toEqual([
      'node_modules/a',
      'node_modules/b',
      'node_modules/c',
    ]);
    expect(result.cycles).toEqual([]);
  });

  it('runs a package after the approved package it depends on, wherever the lock lists that one', async () => {
    const hoisted = await lock(
      [
        ['node_modules/a', ['b']],
        ['node_modules/b', []],
      ],
      ['node_modules/a', 'node_modules/b'],
    ).order;
    expect(paths(hoisted.order)).toEqual(['node_modules/b', 'node_modules/a']);
    // Parents come before what is nested in them in the lock.
    const nested = await lock(
      [
        ['node_modules/a', ['b']],
        ['node_modules/a/node_modules/b', []],
      ],
      ['node_modules/a', 'node_modules/a/node_modules/b'],
    ).order;
    expect(paths(nested.order)).toEqual([
      'node_modules/a/node_modules/b',
      'node_modules/a',
    ]);
  });

  it('resolves a name as Node does: the nearest node_modules first', async () => {
    // `a` loads its own `b`; the hoisted `b` is another package's.
    const { order } = lock(
      [
        ['node_modules/a', ['b']],
        ['node_modules/a/node_modules/b', []],
        ['node_modules/b', ['a']],
      ],
      ['node_modules/a', 'node_modules/a/node_modules/b', 'node_modules/b'],
    );
    const result = await order;
    expect(paths(result.order)).toEqual([
      'node_modules/a/node_modules/b',
      'node_modules/a',
      'node_modules/b',
    ]);
    expect(result.cycles).toEqual([]);
  });

  it('follows a dependency through packages that run nothing', async () => {
    const { order } = lock(
      [
        ['node_modules/a-top', ['b-mid']],
        ['node_modules/b-mid', ['c-base']],
        ['node_modules/c-base', []],
      ],
      ['node_modules/a-top', 'node_modules/c-base'],
    );
    expect(paths((await order).order)).toEqual([
      'node_modules/c-base',
      'node_modules/a-top',
    ]);
  });

  it('orders a diamond: the base, then each side in lock order, then the top', async () => {
    const { order } = lock(
      [
        ['node_modules/a-top', ['b-left', 'c-right']],
        ['node_modules/b-left', ['d-base']],
        ['node_modules/c-right', ['d-base']],
        ['node_modules/d-base', []],
      ],
      [
        'node_modules/a-top',
        'node_modules/b-left',
        'node_modules/c-right',
        'node_modules/d-base',
      ],
    );
    const result = await order;
    expect(paths(result.order)).toEqual([
      'node_modules/d-base',
      'node_modules/b-left',
      'node_modules/c-right',
      'node_modules/a-top',
    ]);
    expect(result.cycles).toEqual([]);
  });

  it("runs a cycle in the lock's order and reports it", async () => {
    const { order } = lock(
      [
        ['node_modules/a', ['b']],
        ['node_modules/b', ['c']],
        ['node_modules/c', ['a']],
        ['node_modules/d', ['b']],
      ],
      ['node_modules/a', 'node_modules/b', 'node_modules/d'],
    );
    const result = await order;
    // `d` needs the cycle, so the cycle goes first, whole.
    expect(paths(result.order)).toEqual([
      'node_modules/a',
      'node_modules/b',
      'node_modules/d',
    ]);
    expect(result.cycles.map(paths)).toEqual([
      ['node_modules/a', 'node_modules/b'],
    ]);
  });

  it('reports no cycle when only one package in it runs a script', async () => {
    const { order } = lock(
      [
        ['node_modules/a', ['b']],
        ['node_modules/b', ['a']],
      ],
      ['node_modules/b'],
    );
    const result = await order;
    expect(paths(result.order)).toEqual(['node_modules/b']);
    expect(result.cycles).toEqual([]);
  });

  it("follows a workspace link to the member, and the member's own dependencies", async () => {
    const { order } = lock(
      [
        ['node_modules/a', ['lib']],
        ['node_modules/b', []],
      ],
      ['node_modules/a', 'node_modules/b'],
      {
        links: [{ path: 'node_modules/lib', target: '../packages/lib' }],
        members: { 'packages/lib': ['b'] },
      },
    );
    expect(paths((await order).order)).toEqual([
      'node_modules/b',
      'node_modules/a',
    ]);
  });

  it("stops at a place a parent's archive bundles, as Node does", async () => {
    // `a` loads the copy bundled in it, not the hoisted `b` that runs a script.
    const { order } = lock(
      [
        ['node_modules/c', []],
        ['node_modules/a', ['b']],
        ['node_modules/b', []],
      ],
      ['node_modules/a', 'node_modules/b', 'node_modules/c'],
      { stops: ['node_modules/a/node_modules/b'] },
    );
    expect(paths((await order).order)).toEqual([
      'node_modules/c',
      'node_modules/a',
      'node_modules/b',
    ]);
  });

  it('reads no manifest when at most one package runs a script', async () => {
    const one = lock(
      [
        ['node_modules/a', ['b']],
        ['node_modules/b', []],
      ],
      ['node_modules/a'],
    );
    expect(paths((await one.order).order)).toEqual(['node_modules/a']);
    expect(one.read).toEqual([]);
  });
});
