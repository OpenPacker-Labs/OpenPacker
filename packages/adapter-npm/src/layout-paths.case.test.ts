import { describe, expect, it } from 'vitest';
import type { NativeLockEntry } from '@openpacker/adapter-core';
import type { LayoutLink } from './layout-links.js';
import {
  LayoutPathsError,
  planLayoutFromPaths,
  type LayoutEntry,
} from './layout-plan.js';

/** A package a lock places at a chain, optionally in a member's own `node_modules`. */
function at(name: string, chain: string[], base?: string, version = '1.0.0') {
  const source = {
    purl: `pkg:npm/${name}`,
    exactPurl: `pkg:npm/${name}@${version}`,
    name,
    version,
    scope: 'runtime',
    source: 'x',
    digest: `sha256:${name}${version}`,
    size: 1,
    transitive: true,
  } satisfies NativeLockEntry;
  const entry: LayoutEntry = {
    id: `${base ?? ''}/${chain.join('>')}`,
    name,
    version,
    digest: source.digest,
    direct: false,
    dependencies: [],
    source,
  };
  return { entry, chain, ...(base !== undefined && { base }) };
}

const MEMBERS = ['packages/a', 'packages/b'];

function problemsOf(
  placed: ReturnType<typeof at>[],
  links: readonly LayoutLink[] = [],
): readonly string[] {
  try {
    planLayoutFromPaths(placed, { members: MEMBERS, links });
  } catch (error) {
    if (error instanceof LayoutPathsError) return error.problems;
    throw error;
  }
  return [];
}

describe('planLayoutFromPaths and names that differ only by case', () => {
  it('refuses two such names in the project’s node_modules', () => {
    expect(problemsOf([at('Foo', ['Foo']), at('foo', ['foo'])])).toEqual([
      expect.stringMatching(
        /would be installed as foo, which differs only by case from Foo.*one directory on a case-insensitive filesystem.*node_modules\/foo/u,
      ),
    ]);
  });

  it('refuses them in one member’s own node_modules, and says which', () => {
    expect(
      problemsOf([
        at('Foo', ['Foo'], 'packages/a'),
        at('foo', ['foo'], 'packages/a'),
      ]),
    ).toEqual([
      expect.stringMatching(/\(at packages\/a\/node_modules\/foo\)/u),
    ]);
  });

  it('refuses them beside each other inside a package', () => {
    expect(
      problemsOf([
        at('host', ['host']),
        at('Foo', ['host', 'Foo']),
        at('foo', ['host', 'foo']),
      ]),
    ).toEqual([
      expect.stringMatching(/\(at node_modules\/host\/node_modules\/foo\)/u),
    ]);
  });

  it('goes by the directory an alias is installed under, not by the package’s own name', () => {
    // One package, twice, under two install names that differ only by case…
    expect(
      problemsOf([
        at('string-width', ['string-width-cjs']),
        at('string-width', ['string-width-CJS']),
      ]),
    ).toHaveLength(1);
    // …but the package beside its own alias is two directories.
    expect(
      problemsOf([
        at('string-width', ['string-width']),
        at('string-width', ['string-width-cjs']),
      ]),
    ).toEqual([]);
  });

  it('keeps each member’s node_modules a namespace of its own', () => {
    const plan = planLayoutFromPaths(
      [
        at('Foo', ['Foo']),
        at('foo', ['foo'], 'packages/a'),
        at('Foo', ['Foo'], 'packages/b'),
        // Another directory again: the nested `node_modules` of a package.
        at('host', ['host']),
        at('foo', ['host', 'foo']),
      ],
      { members: MEMBERS },
    );
    expect(
      plan.placements.map((place) => `${place.base ?? ''}|${place.chain}`),
    ).toEqual([
      '|Foo',
      '|host',
      'packages/a|foo',
      'packages/b|Foo',
      '|host,foo',
    ]);
  });

  it('allows the same name twice in different members, and a name that only looks alike', () => {
    expect(
      problemsOf([
        at('foo', ['foo'], 'packages/a'),
        at('foo', ['foo'], 'packages/b'),
        at('foo-x', ['foo-x']),
        at('fo0', ['fo0']),
      ]),
    ).toEqual([]);
  });
});

describe('planLayoutFromPaths and a workspace member link', () => {
  const link = (path: string, target: string): LayoutLink => ({ path, target });
  const lib = link('node_modules/@fx/lib', '../../packages/lib');
  const upper = link('node_modules/@fx/Lib', '../../packages/Lib');

  it('is one directory with a package whose name differs only by case', () => {
    expect(problemsOf([at('@fx/lib', ['@fx/lib'])], [upper])).toEqual([
      expect.stringMatching(
        /the link to \.\.\/\.\.\/packages\/Lib would be installed as @fx\/Lib, which differs only by case from @fx\/lib \(@fx\/lib@1\.0\.0\).*\(at node_modules\/@fx\/Lib\)/u,
      ),
    ]);
  });

  it('is one directory with another link', () => {
    expect(problemsOf([], [lib, upper])).toEqual([
      expect.stringMatching(
        /the link to \.\.\/\.\.\/packages\/Lib would be installed as @fx\/Lib, which differs only by case from @fx\/lib \(the link to \.\.\/\.\.\/packages\/lib\)/u,
      ),
    ]);
  });

  it('is not one with a package in another directory, or with its own package of the same name', () => {
    expect(
      problemsOf(
        [at('host', ['host']), at('@fx/Lib', ['host', '@fx/Lib'])],
        [lib],
      ),
    ).toEqual([]);
    expect(
      problemsOf([at('@fx/lib', ['@fx/lib'], 'packages/a')], [lib]),
    ).toEqual([]);
  });
});
