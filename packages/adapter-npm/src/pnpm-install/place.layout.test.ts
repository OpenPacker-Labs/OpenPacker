/**
 * One layout, and the pieces a plan is made of, taken one at a time (ADR 0055
 * §9): what a pin does to the edge it names, the election of an empty slot, and
 * which instances and importers are in a cycle. Each case is a world of a few
 * packages whose layout is read path by path.
 */

import { describe, expect, it } from 'vitest';
import { cyclicImporters, cyclicInstances } from './place-cycles.js';
import { knownOf, layOut, pinId, type Strategy } from './place-layout.js';
import { emptySlotChoices } from './place-order.js';
import { instance, top, world } from './place-support.js';
import { lookup, type Node } from './place-tree.js';
import type { PlaceInput } from './place-types.js';

const PLAIN: Strategy = {
  pinned: new Set(),
  elected: new Map(),
  isolated: new Set(),
  limit: 100,
};

/** The directories the layout writes, as the paths they have on disk. */
function paths(placed: readonly Node[]): string[] {
  return placed
    .map(
      (node) =>
        `${node.base === '' ? '' : `${node.base}/`}node_modules/${node.chain.join('/node_modules/')}`,
    )
    .sort();
}

/** The edge `as` of the node holding instance `key`, as a layout's pin names it. */
function pinOf(placed: readonly Node[], key: string, as: string): string {
  const node = placed.find((candidate) => candidate.key === key);
  if (node === undefined) throw new Error(`${key} is not placed`);
  return pinId(node, as);
}

describe('a pinned edge', () => {
  it('is answered beside its dependent, where the copy found above would have done', () => {
    const input = world(
      [instance('a@1.0.0', { c: 'c@1.0.0' }), instance('c@1.0.0')],
      [top('', { a: 'a@1.0.0', c: 'c@1.0.0' })],
    );
    const known = knownOf(input);
    const loose = layOut(input, known, PLAIN);
    expect(paths(loose.placed)).toEqual(['node_modules/a', 'node_modules/c']);
    const pinned = layOut(input, known, {
      ...PLAIN,
      pinned: new Set([pinOf(loose.placed, 'a@1.0.0', 'c')]),
    });
    expect(paths(pinned.placed)).toEqual([
      'node_modules/a',
      'node_modules/a/node_modules/c',
      'node_modules/c',
    ]);
  });

  it('is answered by the package the dependent already sits inside, and never by a copy of it in its own copy', () => {
    // `h` needs `p` at 1, the project has `p` at 2, so `h` holds its own `p`:
    // `p` sits inside `h` and needs `h` as a peer. A pin on that edge cannot
    // write `h` beside `p`: that copy would need its own `p`, nested again.
    const input = world(
      [
        instance('h@1.0.0', { p: 'p@1.0.0' }),
        {
          ...instance('p@1.0.0'),
          edges: [{ as: 'h', to: 'h@1.0.0', peer: true }],
        },
        instance('p@2.0.0'),
      ],
      [top('', { h: 'h@1.0.0', p: 'p@2.0.0' })],
    );
    const known = knownOf(input);
    const loose = layOut(input, known, PLAIN);
    const expected = [
      'node_modules/h',
      'node_modules/h/node_modules/p',
      'node_modules/p',
    ];
    expect(paths(loose.placed)).toEqual(expected);
    const pinned = layOut(input, known, {
      ...PLAIN,
      pinned: new Set([pinOf(loose.placed, 'p@1.0.0', 'h')]),
    });
    expect(paths(pinned.placed)).toEqual(expected);
    const plugin = pinned.placed.find((node) => node.key === 'p@1.0.0')!;
    expect(lookup(plugin, 'h')).toBe(pinned.project.children.get('h'));
  });

  it('applies in the importer it was found in, and not in another that holds the same instance', () => {
    // Both members keep their packages to themselves, so each holds its own
    // node for `a`. The pin is on the first member's.
    const input = world(
      [instance('a@1.0.0', { c: 'c@1.0.0' }), instance('c@1.0.0')],
      [
        top('', {}),
        top('packages/m1', { a: 'a@1.0.0' }),
        top('packages/m2', { a: 'a@1.0.0' }),
      ],
    );
    const known = knownOf(input);
    const isolated = new Set(['packages/m1', 'packages/m2']);
    const loose = layOut(input, known, { ...PLAIN, isolated });
    const first = loose.placed.find(
      (node) => node.key === 'a@1.0.0' && node.base === 'packages/m1',
    )!;
    const pinned = layOut(input, known, {
      ...PLAIN,
      isolated,
      pinned: new Set([pinId(first, 'c')]),
    });
    expect(paths(pinned.placed)).toEqual([
      'packages/m1/node_modules/a',
      'packages/m1/node_modules/a/node_modules/c',
      'packages/m2/node_modules/a',
      'packages/m2/node_modules/c',
    ]);
  });
});

describe('the election of an empty slot', () => {
  it("leaves out what an isolated importer holds, which could not use the project's slot", () => {
    // `x` at 1 is written in two members, the project has no `x`, and the
    // instance the most want, `x` at 2, is wanted only by members that keep
    // their packages to themselves. Counting those would make `x` at 2 the
    // winner, which is the instance that has the slot already.
    const input = world(
      [instance('x@1.0.0'), instance('x@2.0.0')],
      [
        top('', {}),
        top('packages/m1', { x: 'x@1.0.0' }),
        top('packages/m2', { x: 'x@1.0.0' }),
        top('packages/m3', { x: 'x@2.0.0' }),
        top('packages/m4', { x: 'x@2.0.0' }),
        top('packages/m5', { x: 'x@2.0.0' }),
      ],
    );
    const isolated = new Set(['packages/m3', 'packages/m4', 'packages/m5']);
    const laid = layOut(input, knownOf(input), { ...PLAIN, isolated });
    expect(laid.project.children.has('x')).toBe(false);
    expect(laid.preferred.get('x')).toBe('x@2.0.0');
    expect([...emptySlotChoices(laid, input.instances, isolated)]).toEqual([
      ['x', 'x@1.0.0'],
    ]);
    // Counting them, `x` at 2 wins and has the slot already.
    expect(emptySlotChoices(laid, input.instances, new Set()).size).toBe(0);
  });
});

describe('the instances and importers in a cycle', () => {
  const cycle = (input: PlaceInput) => [...cyclicInstances(input)].sort();

  it('are those that need themselves, or one another through any chain', () => {
    const input = world(
      [
        instance('loop@1.0.0', { loop: 'loop@1.0.0' }),
        instance('ping@1.0.0', { pong: 'pong@1.0.0' }),
        instance('pong@1.0.0', { ping: 'ping@1.0.0' }),
        instance('mid@1.0.0', { ping: 'ping@1.0.0' }),
        instance('leaf@1.0.0'),
      ],
      [top('', {})],
    );
    // A package that only reaches a cycle is not in it.
    expect(cycle(input)).toEqual(['loop@1.0.0', 'ping@1.0.0', 'pong@1.0.0']);
  });

  it('are none in a lock that has none', () => {
    const input = world(
      [instance('a@1.0.0', { b: 'b@1.0.0' }), instance('b@1.0.0')],
      [top('', { a: 'a@1.0.0' })],
    );
    expect(cycle(input)).toEqual([]);
    expect(cyclicImporters(input).size).toBe(0);
  });

  it('name the members whose dependencies reach one, a package that needs itself included', () => {
    const input = world(
      [
        instance('loop@1.0.0', { loop: 'loop@1.0.0' }),
        instance('wrap@1.0.0', { loop: 'loop@1.0.0' }),
        instance('plain@1.0.0'),
      ],
      [
        top('', { loop: 'loop@1.0.0' }),
        top('packages/direct', { loop: 'loop@1.0.0' }),
        top('packages/through', { wrap: 'wrap@1.0.0' }),
        top('packages/free', { plain: 'plain@1.0.0' }),
      ],
    );
    // The project is never one: it is not an importer that can keep to itself.
    expect([...cyclicImporters(input)].sort()).toEqual([
      'packages/direct',
      'packages/through',
    ]);
  });
});
