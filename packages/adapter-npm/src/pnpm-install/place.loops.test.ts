/**
 * One layout under the two strategies a plan reaches for when a layout cannot
 * be written or leaves a split (ADR 0055 §9, round 8): an edge written as high
 * as its peers allow, and the packages a copy nested in a copy of itself is
 * shadowed by. Each case is a world of a few packages whose layout is read
 * path by path.
 */

import { describe, expect, it } from 'vitest';
import {
  knownOf,
  layOut,
  LayoutOutgrown,
  pinId,
  type Strategy,
} from './place-layout.js';
import { peerWorld } from './place-peer-worlds.js';
import { instance, top, world } from './place-support.js';
import type { Node } from './place-tree.js';

const PLAIN: Strategy = {
  pinned: new Set(),
  elected: new Map(),
  isolated: new Set(),
  lifted: new Set(),
  limit: 5000,
};

const paths = (placed: readonly Node[]): string[] =>
  placed
    .map((node) => `node_modules/${node.chain.join('/node_modules/')}`)
    .sort();

/** The pin of edge `as` of the node holding `key`, wherever it is placed first. */
function pinOf(placed: readonly Node[], key: string, as: string): string {
  const node = placed.find((candidate) => candidate.key === key);
  if (node === undefined) throw new Error(`${key} is not placed`);
  return pinId(node, as);
}

describe('an edge written as high as its peers allow', () => {
  // The project holds `a@2` and `c@2`, so `h` holds its own `a@1`, and `a@1`
  // finds another instance of `c` and has the copy of `c@1` it needs written
  // beside it, in its own directory.
  const input = world(
    [
      instance('h@1.0.0', { a: 'a@1.0.0' }),
      instance('a@1.0.0', { c: 'c@1.0.0' }),
      instance('c@1.0.0'),
      instance('c@2.0.0'),
      instance('a@2.0.0'),
    ],
    [top('', { h: 'h@1.0.0', c: 'c@2.0.0', a: 'a@2.0.0' })],
  );
  const known = knownOf(input);
  const beside = layOut(input, known, PLAIN);

  it('is written beside its dependent when another instance answers the name', () => {
    expect(paths(beside.placed)).toEqual([
      'node_modules/a',
      'node_modules/c',
      'node_modules/h',
      'node_modules/h/node_modules/a',
      'node_modules/h/node_modules/a/node_modules/c',
    ]);
  });

  it('is written in the directory above, below whatever answers the name, when it is lifted', () => {
    const lifted = layOut(input, known, {
      ...PLAIN,
      lifted: new Set([pinOf(beside.placed, 'a@1.0.0', 'c')]),
    });
    expect(paths(lifted.placed)).toEqual([
      'node_modules/a',
      'node_modules/c',
      'node_modules/h',
      'node_modules/h/node_modules/a',
      'node_modules/h/node_modules/c',
    ]);
  });

  it('goes no higher than a peer it shares with its dependent allows', () => {
    // `c@1` peers `s@1`, which `a` requires too and finds in its own
    // directory because the project holds `s@2`: a copy of `c@1` in `h`'s
    // directory would find the project's `s` instead.
    const shared = world(
      [
        instance('h@1.0.0', { a: 'a@1.0.0' }),
        instance('a@1.0.0', { c: 'c@1.0.0', s: 's@1.0.0' }),
        {
          ...instance('c@1.0.0'),
          edges: [{ as: 's', to: 's@1.0.0', peer: true }],
        },
        instance('c@2.0.0'),
        instance('s@1.0.0'),
        instance('s@2.0.0'),
        instance('a@2.0.0'),
      ],
      [
        top('', {
          h: 'h@1.0.0',
          c: 'c@2.0.0',
          s: 's@2.0.0',
          a: 'a@2.0.0',
        }),
      ],
    );
    const laid = layOut(shared, knownOf(shared), PLAIN);
    const lifted = layOut(shared, knownOf(shared), {
      ...PLAIN,
      lifted: new Set([pinOf(laid.placed, 'a@1.0.0', 'c')]),
    });
    expect(paths(laid.placed)).toContain(
      'node_modules/h/node_modules/a/node_modules/c',
    );
    expect(paths(laid.placed)).toContain(
      'node_modules/h/node_modules/a/node_modules/s',
    );
    expect(paths(lifted.placed)).toEqual(paths(laid.placed));
  });
});

describe('the packages a copy nested in a copy of itself is shadowed by', () => {
  it('are none in a layout that has no such copy', () => {
    const input = world(
      [instance('a@1.0.0', { b: 'b@1.0.0' }), instance('b@1.0.0')],
      [top('', { a: 'a@1.0.0' })],
    );
    const laid = layOut(input, knownOf(input), PLAIN);
    expect(laid.problems).toEqual([]);
    expect(laid.loops.names.size).toBe(0);
    expect(laid.loops.edges.size).toBe(0);
  });

  it('are named where the layout is too deep: the package between, and the edge that wrote it', () => {
    // `p4@1` needs `p6@2` below itself, and `p6@2` needs `p4@1` as a peer
    // while `p4@1` holds a `p4@2` under the same name: every copy of `p4@1`
    // nested to satisfy the peer is shadowed by the copy above.
    const input = peerWorld('too-deep.json');
    const laid = layOut(input, knownOf(input), PLAIN);
    expect(laid.problems).toHaveLength(1);
    expect(laid.problems[0]).toMatch(/more than 32 directories deep/u);
    expect([...laid.loops.names]).toEqual([['p6', 'p6@2.0.0']]);
    expect([...laid.loops.edges]).toEqual([
      pinOf(laid.placed, 'p4@1.0.0', 'p6'),
    ]);
  });

  it('are named where the layout outgrows its bound before it is deep enough to be refused', () => {
    const input = peerWorld('too-large.json');
    let outgrown: unknown;
    try {
      layOut(input, knownOf(input), { ...PLAIN, limit: 328 });
    } catch (error) {
      outgrown = error;
    }
    expect(outgrown).toBeInstanceOf(LayoutOutgrown);
    const { loops } = outgrown as LayoutOutgrown;
    expect([...loops.names]).toEqual([
      ['p6', 'p6@2.0.0'],
      ['p4', 'p4@1.0.0'],
      ['p2', 'p2@2.0.0'],
    ]);
    expect(loops.edges.size).toBe(5);
    expect((outgrown as LayoutOutgrown).code).toBe('LAYOUT_TOO_LARGE');
  });

  it('are none where the layout is too big and no package sits inside a copy of itself', () => {
    // A chain of distinct packages: those above the one refused are not
    // between it and a copy of itself, for there is none.
    const input = world(
      [
        instance('a@1.0.0', { b: 'b@1.0.0' }),
        instance('b@1.0.0', { c: 'c@1.0.0' }),
        instance('c@1.0.0', { d: 'd@1.0.0' }),
        instance('d@1.0.0'),
      ],
      [top('', { a: 'a@1.0.0' })],
    );
    let outgrown: unknown;
    try {
      layOut(input, knownOf(input), { ...PLAIN, limit: 3 });
    } catch (error) {
      outgrown = error;
    }
    expect(outgrown).toBeInstanceOf(LayoutOutgrown);
    expect((outgrown as LayoutOutgrown).loops.names.size).toBe(0);
    expect((outgrown as LayoutOutgrown).loops.edges.size).toBe(0);
  });
});
