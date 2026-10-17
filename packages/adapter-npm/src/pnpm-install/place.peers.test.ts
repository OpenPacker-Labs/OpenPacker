import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { placePath } from '../layout-links.js';
import { planPlacement, type PlaceInput, type Placement } from './place.js';
import { peerSplitProblems, resolutionProblems } from './place-check.js';
import { instance, top, world } from './place-support.js';

function whereIs(placement: Placement): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const item of placement.placed)
    (out[item.key] ??= []).push(placePath(item.chain, item.base));
  return out;
}

/** Plan, and require the plan to prove itself, peers included. */
function plan(input: PlaceInput): Placement {
  const placement = planPlacement(input);
  expect(placement.problems).toEqual([]);
  expect(resolutionProblems(input, placement)).toEqual([]);
  expect(peerSplitProblems(input, placement)).toEqual([]);
  return placement;
}

const R2 = 'react@18.2.0';
const R3 = 'react@18.3.1';

describe('a package below a member or a dependency, with a peer its dependent requires too', () => {
  it("writes a member dependency's own dependency beside the member's copy of the peer, not at the project (B)", () => {
    // web -> kit(react@18.2) -> dom(react@18.2); the project holds 18.3.
    const kit = 'kit@1.0.0(react@18.2.0)';
    const dom = 'dom@1.0.0(react@18.2.0)';
    const placement = plan(
      world(
        [
          instance(R2),
          instance(R3),
          instance(kit, { dom, react: R2 }),
          instance(dom, { react: R2 }),
        ],
        [top('', { react: R3 }), top('packages/web', { kit, react: R2 })],
      ),
    );
    expect(whereIs(placement)).toEqual({
      [R3]: ['node_modules/react'],
      [R2]: ['packages/web/node_modules/react'],
      [kit]: ['packages/web/node_modules/kit'],
      // As high as web's react is found from, which is web's node_modules,
      // and so shared by everything else in web that needs it.
      [dom]: ['packages/web/node_modules/dom'],
    });
  });

  it('nests a dependency beside a package of the project that holds its own copy of the peer (C)', () => {
    const dom = 'dom@1.0.0(react@18.2.0)';
    const placement = plan(
      world(
        [
          instance(R2),
          instance(R3),
          instance('app@1.0.0', { dom, react: R2 }),
          instance(dom, { react: R2 }),
        ],
        [top('', { react: R3, app: 'app@1.0.0' })],
      ),
    );
    expect(whereIs(placement)[dom]).toEqual([
      'node_modules/app/node_modules/dom',
    ]);
    expect(whereIs(placement)[R2]).toEqual([
      'node_modules/app/node_modules/react',
    ]);
  });

  it('keeps a UI kit and its system with each member on another React than the project (H)', () => {
    const mui = 'mui@5.0.0(react@18.2.0)';
    const system = 'system@5.0.0(react@18.2.0)';
    const placement = plan(
      world(
        [
          instance('react@19.0.0'),
          instance(R2),
          instance(mui, { system, react: R2 }),
          instance(system, { react: R2 }),
        ],
        [
          top('', { react: 'react@19.0.0' }),
          top('packages/a', { mui, react: R2 }),
          top('packages/b', { mui, react: R2 }, { a: 'packages/a' }),
        ],
      ),
    );
    expect(whereIs(placement)[system]).toEqual([
      'packages/a/node_modules/system',
      'packages/b/node_modules/system',
    ]);
  });

  it("still shares one copy from above when the peer it finds there is the dependent's own", () => {
    const dom = 'dom@1.0.0(react@18.3.1)';
    const placement = plan(
      world(
        [
          instance(R3),
          instance('kit@1.0.0', { dom, react: R3 }),
          instance(dom, { react: R3 }),
        ],
        [
          top('', { react: R3 }),
          top('packages/a', { kit: 'kit@1.0.0', react: R3 }),
          top('packages/b', { kit: 'kit@1.0.0', react: R3 }),
        ],
      ),
    );
    expect(whereIs(placement)).toEqual({
      [R3]: ['node_modules/react'],
      'kit@1.0.0': ['node_modules/kit'],
      [dom]: ['node_modules/dom'],
    });
  });

  it("reads a peer from the package's own peerDependencies when the key carries no suffix", () => {
    const placement = plan({
      instances: new Map([
        [R2, instance(R2)],
        [R3, instance(R3)],
        ['app@1.0.0', instance('app@1.0.0', { dom: 'dom@1.0.0', react: R2 })],
        [
          'dom@1.0.0',
          {
            ...instance('dom@1.0.0'),
            edges: [{ as: 'react', to: R2, peer: true }],
          },
        ],
      ]),
      tops: [top('', { react: R3, app: 'app@1.0.0' })],
    });
    expect(whereIs(placement)['dom@1.0.0']).toEqual([
      'node_modules/app/node_modules/dom',
    ]);
  });
});

describe("two packages that are each other's peers", () => {
  it('answers the edge beside its dependent on a second plan when the first one split a peer', () => {
    // b is placed before a (each is the other's peer, so neither goes first),
    // and goes to the project, where it would find the project's a@2. The
    // check after the plan finds that and writes b beside p.
    const placement = plan({
      instances: new Map([
        ['a@2.0.0', instance('a@2.0.0')],
        [
          'a@1.0.0',
          {
            ...instance('a@1.0.0'),
            edges: [{ as: 'b', to: 'b@1.0.0', peer: true }],
          },
        ],
        [
          'b@1.0.0',
          {
            ...instance('b@1.0.0'),
            edges: [{ as: 'a', to: 'a@1.0.0', peer: true }],
          },
        ],
      ]),
      tops: [
        top('', { a: 'a@2.0.0' }),
        top('packages/p', { a: 'a@1.0.0', b: 'b@1.0.0' }),
      ],
    });
    expect(whereIs(placement)).toEqual({
      'a@2.0.0': ['node_modules/a'],
      'a@1.0.0': ['packages/p/node_modules/a'],
      'b@1.0.0': ['packages/p/node_modules/b'],
    });
  });
});

describe('the peer check is not vacuous', () => {
  it("names a dependency that loads another copy of its dependent's peer", () => {
    const dom = 'dom@1.0.0(react@18.2.0)';
    const input = world(
      [
        instance(R2),
        instance(R3),
        instance('app@1.0.0', { dom, react: R2 }),
        instance(dom, { react: R2 }),
      ],
      [top('', { react: R3, app: 'app@1.0.0' })],
    );
    // The plan before the peer rule: dom at the project with its own react.
    const split: Placement = {
      placed: [
        { key: R3, base: '', chain: ['react'], direct: true },
        { key: 'app@1.0.0', base: '', chain: ['app'], direct: true },
        { key: dom, base: '', chain: ['dom'], direct: false },
        { key: R2, base: '', chain: ['app', 'react'], direct: false },
        { key: R2, base: '', chain: ['dom', 'react'], direct: false },
      ],
      links: [],
      problems: [],
    };
    expect(resolutionProblems(input, split)).toEqual([]);
    expect(peerSplitProblems(input, split)).toEqual([
      '"app@1.0.0" at "node_modules/app" loads "react@18.2.0" from "node_modules/app/node_modules/react", and its "dom" at "node_modules/dom" loads another copy from "node_modules/dom/node_modules/react"',
    ]);
  });
});

describe('random worlds of peer variants', () => {
  const reacts = ['r@1.0.0', 'r@2.0.0', 'r@3.0.0'];
  const worlds = fc
    .record({
      libs: fc.array(
        fc.record({
          lib: fc.integer({ min: 0, max: 5 }),
          react: fc.integer({ min: 0, max: 2 }),
          needs: fc.array(fc.integer({ min: 0, max: 5 }), { maxLength: 2 }),
        }),
        { maxLength: 12 },
      ),
      project: fc.integer({ min: 0, max: 2 }),
      members: fc.array(
        fc.record({
          dir: fc.constantFrom('m0', 'm1', 'm2', 'm0/sub', 'm1/sub'),
          react: fc.integer({ min: 0, max: 2 }),
          libs: fc.array(fc.integer({ min: 0, max: 5 }), { maxLength: 4 }),
        }),
        { minLength: 1, maxLength: 4 },
      ),
    })
    .map(({ libs, project, members }): PlaceInput => {
      const keyOf = (lib: number, react: number) =>
        `l${lib}@1.0.0(${reacts[react]})`;
      const declared = new Map<string, Record<string, string>>();
      for (const { lib, react, needs } of libs) {
        const edges: Record<string, string> = { r: reacts[react]! };
        for (const other of needs)
          if (other !== lib && declared.has(keyOf(other, react)))
            edges[`l${other}`] = keyOf(other, react);
        if (!declared.has(keyOf(lib, react)))
          declared.set(keyOf(lib, react), edges);
      }
      const tops = [top('', { r: reacts[project]! })];
      for (const member of members) {
        if (tops.some((t) => t.dir === `packages/${member.dir}`)) continue;
        const edges: Record<string, string> = { r: reacts[member.react]! };
        for (const lib of member.libs)
          if (declared.has(keyOf(lib, member.react)))
            edges[`l${lib}`] = keyOf(lib, member.react);
        tops.push(top(`packages/${member.dir}`, edges));
      }
      const all = [
        ...reacts.map((key) => instance(key)),
        ...[...declared].map(([key, edges]) => instance(key, edges)),
      ];
      const reached = new Set<string>();
      const pending = tops.flatMap((t) => t.edges.map((e) => e.to));
      for (let key = pending.pop(); key !== undefined; key = pending.pop()) {
        if (reached.has(key)) continue;
        reached.add(key);
        pending.push(...Object.values(declared.get(key) ?? {}));
      }
      return world(
        all.filter((item) => reached.has(item.key)),
        tops,
      );
    });

  it('resolves every edge and loads every shared peer once, whatever the world', () => {
    fc.assert(
      fc.property(worlds, (input) => {
        const placement = planPlacement(input);
        expect(placement.problems).toEqual([]);
        expect(resolutionProblems(input, placement)).toEqual([]);
        expect(peerSplitProblems(input, placement)).toEqual([]);
      }),
      { numRuns: 600, seed: 20261017 },
    );
  });

  it('is the same plan whatever order the instances, tops and edges are listed in', () => {
    fc.assert(
      fc.property(worlds, (input) => {
        const reversed: PlaceInput = {
          instances: new Map(
            [...input.instances]
              .reverse()
              .map(([key, item]) => [
                key,
                { ...item, edges: [...item.edges].reverse() },
              ]),
          ),
          tops: [
            input.tops[0]!,
            ...input.tops
              .slice(1)
              .reverse()
              .map((t) => ({ ...t, edges: [...t.edges].reverse() })),
          ],
        };
        expect(planPlacement(reversed)).toEqual(planPlacement(input));
      }),
      { numRuns: 300, seed: 20261018 },
    );
  });
});
