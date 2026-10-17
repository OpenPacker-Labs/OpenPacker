import { describe, expect, it } from 'vitest';
import { placePath } from '../layout-links.js';
import { planPlacement, type PlaceInput, type Placement } from './place.js';
import { resolutionProblems } from './place-check.js';
import { instance, top, world } from './place-support.js';

/** Where every key is, as the lock would spell it. */
function whereIs(placement: Placement): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const item of placement.placed)
    (out[item.key] ??= []).push(placePath(item.chain, item.base));
  return out;
}

/** Plan, and require the plan to prove itself. */
function plan(input: PlaceInput): Placement {
  const placement = planPlacement(input);
  expect(placement.problems).toEqual([]);
  expect(resolutionProblems(input, placement)).toEqual([]);
  return placement;
}

describe('where a top and its dependencies go', () => {
  it("puts a top's direct dependencies in its own node_modules and shares the rest at the project", () => {
    const input = world(
      [
        instance('a@1.0.0', { shared: 'shared@1.0.0' }),
        instance('b@1.0.0', { shared: 'shared@1.0.0' }),
        instance('shared@1.0.0'),
      ],
      [top('', { a: 'a@1.0.0' }), top('packages/web', { b: 'b@1.0.0' })],
    );
    expect(whereIs(plan(input))).toEqual({
      'a@1.0.0': ['node_modules/a'],
      'b@1.0.0': ['packages/web/node_modules/b'],
      'shared@1.0.0': ['node_modules/shared'],
    });
  });

  it("keeps a member's direct dependency in the member even when the project has the same instance", () => {
    const input = world(
      [instance('left@1.0.0')],
      [
        top('', { left: 'left@1.0.0' }),
        top('packages/web', { left: 'left@1.0.0' }),
      ],
    );
    expect(whereIs(plan(input))['left@1.0.0']).toEqual([
      'node_modules/left',
      'packages/web/node_modules/left',
    ]);
  });

  it('gives the project to the version most packages want and nests the other beside its dependent', () => {
    const input = world(
      [
        instance('p@1.0.0', { x: 'x@1.0.0' }),
        instance('q@1.0.0', { x: 'x@1.0.0' }),
        instance('r@1.0.0', { x: 'x@2.0.0' }),
        instance('x@1.0.0'),
        instance('x@2.0.0'),
      ],
      [top('', { p: 'p@1.0.0', q: 'q@1.0.0', r: 'r@1.0.0' })],
    );
    const found = whereIs(plan(input));
    expect(found['x@1.0.0']).toEqual(['node_modules/x']);
    expect(found['x@2.0.0']).toEqual(['node_modules/r/node_modules/x']);
  });

  it('breaks a tie between versions for the newer, then for the smaller key', () => {
    const input = world(
      [
        instance('p@1.0.0', { x: 'x@1.0.0' }),
        instance('r@1.0.0', { x: 'x@2.0.0' }),
        instance('x@1.0.0'),
        instance('x@2.0.0'),
      ],
      [top('', { p: 'p@1.0.0', r: 'r@1.0.0' })],
    );
    expect(whereIs(plan(input))['x@2.0.0']).toEqual(['node_modules/x']);
  });

  it("places an alias under its own name as the target package's directory", () => {
    const input = world(
      [
        instance('cliui@8.0.2', { 'string-width-cjs': 'string-width@4.2.3' }),
        instance('string-width@4.2.3'),
      ],
      [top('', { cliui: 'cliui@8.0.2' })],
    );
    expect(whereIs(plan(input))['string-width@4.2.3']).toEqual([
      'node_modules/string-width-cjs',
    ]);
  });
});

describe('peer-suffixed instances of one package', () => {
  const input = world(
    [
      instance('dom@18.2.0(react@18.2.0)', { react: 'react@18.2.0' }),
      instance('dom@18.2.0(react@18.3.0)', { react: 'react@18.3.0' }),
      instance('a@1.0.0', {
        dom: 'dom@18.2.0(react@18.2.0)',
        react: 'react@18.2.0',
      }),
      instance('b@1.0.0', {
        dom: 'dom@18.2.0(react@18.3.0)',
        react: 'react@18.3.0',
      }),
      instance('react@18.2.0'),
      instance('react@18.3.0'),
    ],
    [top('packages/a', { a: 'a@1.0.0' }), top('packages/b', { b: 'b@1.0.0' })],
  );

  it('places each variant where its dependent resolves its own peer', () => {
    const found = whereIs(plan(input));
    expect(Object.keys(found).sort()).toEqual([
      'a@1.0.0',
      'b@1.0.0',
      'dom@18.2.0(react@18.2.0)',
      'dom@18.2.0(react@18.3.0)',
      'react@18.2.0',
      'react@18.3.0',
    ]);
  });

  it('is two places of one package, which the host extracts once', () => {
    const found = whereIs(plan(input));
    const places = [
      ...found['dom@18.2.0(react@18.2.0)']!,
      ...found['dom@18.2.0(react@18.3.0)']!,
    ];
    expect(new Set(places).size).toBe(places.length);
  });
});

describe('members', () => {
  it('links a member at node_modules/<name> and nests a package that wants the name for itself', () => {
    const input = world(
      [instance('uses-lib@1.0.0', { lib: 'lib@9.0.0' }), instance('lib@9.0.0')],
      [
        top('', {}, { lib: 'packages/lib' }),
        top('packages/lib'),
        top('packages/web', { 'uses-lib': 'uses-lib@1.0.0' }),
      ],
    );
    const placement = plan(input);
    expect(placement.links).toEqual([
      { name: 'lib', memberDir: 'packages/lib' },
    ]);
    expect(whereIs(placement)['lib@9.0.0']).toEqual([
      'packages/web/node_modules/uses-lib/node_modules/lib',
    ]);
  });

  it('refuses a project dependency that takes the name of a member another importer links', () => {
    const input = world(
      [instance('lib@9.0.0')],
      [
        top('', { lib: 'lib@9.0.0' }),
        top('packages/web', {}, { lib: 'packages/lib' }),
        top('packages/lib'),
      ],
    );
    const placement = planPlacement(input);
    expect(placement.problems).toHaveLength(1);
    expect(placement.problems[0]).toContain('lib');
  });

  it('refuses one name linked to two members', () => {
    const input = world(
      [],
      [
        top('', {}, { lib: 'packages/one' }),
        top('packages/web', {}, { lib: 'packages/two' }),
      ],
    );
    expect(planPlacement(input).problems[0]).toContain('cannot be both');
  });

  it('looks in the enclosing member before the project, as Node does for a nested member', () => {
    // `ext` has x@1; `ext/inner` needs x@2 through b. Hoisting x@2 to the
    // project would be shadowed by ext's x@1 on the way up.
    const input = world(
      [
        instance('x@1.0.0'),
        instance('x@2.0.0'),
        instance('b@1.0.0', { x: 'x@2.0.0' }),
      ],
      [top('ext', { x: 'x@1.0.0' }), top('ext/inner', { b: 'b@1.0.0' })],
    );
    const found = whereIs(plan(input));
    expect(found['x@2.0.0']).toEqual([
      'ext/inner/node_modules/b/node_modules/x',
    ]);
  });

  it('notices a hoist that an enclosing member shadows (the checker is not vacuous)', () => {
    const input = world(
      [
        instance('x@1.0.0'),
        instance('x@2.0.0'),
        instance('b@1.0.0', { x: 'x@2.0.0' }),
      ],
      [top('ext', { x: 'x@1.0.0' }), top('ext/inner', { b: 'b@1.0.0' })],
    );
    const wrong: Placement = {
      placed: [
        { key: 'x@1.0.0', base: 'ext', chain: ['x'], direct: true },
        { key: 'b@1.0.0', base: 'ext/inner', chain: ['b'], direct: true },
        { key: 'x@2.0.0', base: '', chain: ['x'], direct: false },
      ],
      links: [],
      problems: [],
    };
    const problems = resolutionProblems(input, wrong);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('b@1.0.0');
    expect(problems[0]).toContain('x@1.0.0');
  });

  it('notices an instance with no place, an edge to the wrong instance and a missing link', () => {
    const input = world(
      [
        instance('a@1.0.0', { b: 'b@1.0.0' }),
        instance('b@1.0.0'),
        instance('c@1.0.0'),
      ],
      [top('', { a: 'a@1.0.0' }, { lib: 'packages/lib' }), top('packages/lib')],
    );
    const problems = resolutionProblems(input, {
      placed: [{ key: 'a@1.0.0', base: '', chain: ['a'], direct: true }],
      links: [],
      problems: [],
    });
    expect(problems.join('\n')).toContain(
      '"a@1.0.0" at "node_modules/a" needs "b"',
    );
    expect(problems.join('\n')).toContain('links "packages/lib" as "lib"');
    expect(problems.join('\n')).toContain('"c@1.0.0" is in the plan');
  });
});

describe('names', () => {
  it('nests a name that differs only by case from one already in the directory', () => {
    const input = world(
      [
        instance('Foo@1.0.0'),
        instance('foo@1.0.0'),
        instance('p@1.0.0', { foo: 'foo@1.0.0' }),
      ],
      [top('', { Foo: 'Foo@1.0.0', p: 'p@1.0.0' })],
    );
    expect(whereIs(plan(input))['foo@1.0.0']).toEqual([
      'node_modules/p/node_modules/foo',
    ]);
  });

  it('refuses an alias that is not a directory name', () => {
    const input = world(
      [instance('p@1.0.0', { '../evil': 'x@1.0.0' }), instance('x@1.0.0')],
      [top('', { p: 'p@1.0.0' })],
    );
    expect(planPlacement(input).problems[0]).toContain(
      'not an npm package name',
    );
  });

  it('is the same plan whatever order the instances and tops are listed in', () => {
    const list = [
      instance('p@1.0.0', { x: 'x@1.0.0' }),
      instance('q@1.0.0', { x: 'x@2.0.0' }),
      instance('x@1.0.0'),
      instance('x@2.0.0'),
    ];
    const tops = [
      top('', { p: 'p@1.0.0' }),
      top('packages/a', { q: 'q@1.0.0' }),
    ];
    const one = planPlacement(world(list, tops));
    const other = planPlacement(
      world([...list].reverse(), [...tops].reverse()),
    );
    expect(other).toEqual(one);
  });
});
