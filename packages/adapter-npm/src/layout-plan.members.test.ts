import { describe, expect, it } from 'vitest';
import type { NativeLockEntry } from '@openpacker/adapter-core';
import { placePath } from './layout-links.js';
import {
  LayoutPathsError,
  planLayoutFromPaths,
  type LayoutEntry,
} from './layout-plan.js';

function layoutEntry(id: string, version = '1.0.0'): LayoutEntry {
  const source = {
    purl: `pkg:npm/${id}`,
    exactPurl: `pkg:npm/${id}@${version}`,
    name: id,
    version,
    scope: 'runtime',
    source: 'x',
    digest: `sha256:${id}${version}`,
    size: 1,
    transitive: true,
  } satisfies NativeLockEntry;
  return {
    id: `${id}@${version}@${Math.random()}`,
    name: id,
    version,
    digest: source.digest,
    direct: false,
    dependencies: [],
    source,
  };
}

const at = (id: string, base: string | undefined, ...chain: string[]) => ({
  entry: layoutEntry(id),
  chain,
  ...(base !== undefined && { base }),
});

describe('a plan with packages inside workspace members', () => {
  it("keeps the member's place for a name apart from the project's", () => {
    const plan = planLayoutFromPaths(
      [
        at('x', 'packages/a', 'x'),
        at('x', undefined, 'x'),
        at('x', 'packages/b', 'x'),
      ],
      { members: ['packages/a', 'packages/b'] },
    );
    expect(plan.placements.map((p) => placePath(p.chain, p.base))).toEqual([
      'node_modules/x',
      'packages/a/node_modules/x',
      'packages/b/node_modules/x',
    ]);
  });

  it('puts parents before what is inside them, in every member', () => {
    const plan = planLayoutFromPaths(
      [
        at('c', 'packages/a', 'b', 'c'),
        at('b', 'packages/a', 'b'),
        at('d', undefined, 'd'),
      ],
      { members: ['packages/a'] },
    );
    expect(plan.placements.map((p) => placePath(p.chain, p.base))).toEqual([
      'node_modules/d',
      'packages/a/node_modules/b',
      'packages/a/node_modules/b/node_modules/c',
    ]);
  });

  it('refuses a package in a directory no member was named for', () => {
    expect(() =>
      planLayoutFromPaths([at('x', 'vendor/lib', 'x')], {
        members: ['packages/a'],
      }),
    ).toThrow(LayoutPathsError);
    expect(() => planLayoutFromPaths([at('x', 'packages/a', 'x')])).toThrow(
      /lives in packages\/a, which is not a workspace member the layout was given/u,
    );
  });

  it('refuses two packages for one place in a member', () => {
    expect(() =>
      planLayoutFromPaths(
        [at('x', 'packages/a', 'x'), at('y', 'packages/a', 'x')],
        {
          members: ['packages/a'],
        },
      ),
    ).toThrow(/both claim packages\/a\/node_modules\/x/u);
  });

  it('refuses a package inside a parent the member does not have', () => {
    expect(() =>
      planLayoutFromPaths([at('c', 'packages/a', 'b', 'c')], {
        members: ['packages/a'],
      }),
    ).toThrow(
      /lives inside packages\/a\/node_modules\/b, which is not installed/u,
    );
    // The project's own b does not stand in for the member's.
    expect(() =>
      planLayoutFromPaths(
        [at('b', undefined, 'b'), at('c', 'packages/a', 'b', 'c')],
        {
          members: ['packages/a'],
        },
      ),
    ).toThrow(/packages\/a\/node_modules\/b, which is not installed/u);
  });

  it("lets a member's link and the packages in the member's own node_modules be", () => {
    const plan = planLayoutFromPaths([at('x', 'packages/one', 'x')], {
      members: ['packages/one'],
      links: [{ path: 'node_modules/one', target: '../packages/one' }],
    });
    expect(plan.links.map((l) => l.path)).toEqual(['node_modules/one']);
    expect(plan.placements.map((p) => placePath(p.chain, p.base))).toEqual([
      'packages/one/node_modules/x',
    ]);
  });

  it("refuses a link where a member's package is installed", () => {
    expect(() =>
      planLayoutFromPaths([at('one', undefined, 'one')], {
        links: [{ path: 'node_modules/one', target: '../packages/one' }],
      }),
    ).toThrow(/would replace the package the plan installs there/u);
  });
});
