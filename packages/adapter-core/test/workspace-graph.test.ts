import { describe, expect, it } from 'vitest';
import { dependenciesOf, dependentsOf, type LinkPolicy } from '../src/index.js';
import { codeOf, type Tree } from './workspace-helpers.js';
import {
  edgeNames,
  fixture,
  fixtureTree,
  graphOf,
} from './workspace-graph-helpers.js';

describe('edges', () => {
  const tree: Tree = {
    '': { name: 'root', devDependencies: { a: 'workspace:*' } },
    'packages/a': {
      name: 'a',
      version: '1.0.0',
      dependencies: { b: 'workspace:^1.0.0', zlib: '^1.0.0' },
      optionalDependencies: { c: 'workspace:*' },
      peerDependencies: { d: 'workspace:*' },
      peerDependenciesMeta: { d: { optional: true } },
    },
    'packages/b': { name: 'b', version: '1.4.0' },
    'packages/c': { name: 'c', version: '2.0.0' },
    'packages/d': {
      name: 'd',
      version: '3.0.0',
      dependencies: { b: 'workspace:~' },
    },
  };

  it('points at the member a workspace: specifier names, in every list', () => {
    const graph = graphOf(tree);
    expect(edgeNames(graph)).toEqual([
      'root > a > a',
      'a > b > b',
      'a > c > c',
      'a > d > d',
      'd > b > b',
    ]);
    expect(
      graph.edges.map((e) => [e.dependency, e.field, e.via, e.optional]),
    ).toEqual([
      ['a', 'devDependencies', 'workspace-protocol', false],
      ['b', 'dependencies', 'workspace-protocol', false],
      ['c', 'optionalDependencies', 'workspace-protocol', true],
      ['d', 'peerDependencies', 'workspace-protocol', true],
      ['b', 'dependencies', 'workspace-protocol', false],
    ]);
  });

  it('indexes both directions', () => {
    const graph = graphOf(tree);
    expect(dependenciesOf(graph, 'packages/a')).toEqual([
      'packages/b',
      'packages/c',
      'packages/d',
    ]);
    expect(dependentsOf(graph, 'packages/b')).toEqual([
      'packages/a',
      'packages/d',
    ]);
    expect(dependentsOf(graph, 'packages/b', { transitive: true })).toEqual([
      '',
      'packages/a',
      'packages/d',
    ]);
    expect(dependenciesOf(graph, '', { transitive: true })).toEqual([
      'packages/a',
      'packages/b',
      'packages/c',
      'packages/d',
    ]);
    expect(
      dependentsOf(graph, 'packages/a', { fields: ['dependencies'] }),
    ).toEqual([]);
  });

  it('counts a key once, under the list that wins, as pnpm merges them', () => {
    const graph = graphOf({
      '': { name: 'root' },
      'packages/a': {
        name: 'a',
        peerDependencies: { b: 'workspace:*' },
        devDependencies: { b: 'workspace:*' },
        dependencies: { b: '^9.9.9' },
      },
      'packages/b': { name: 'b', version: '1.0.0' },
    });
    // dependencies wins and is an ordinary registry range under pnpm's policy: no edge.
    expect(graph.edges).toEqual([]);
    const dev = graphOf({
      '': { name: 'root' },
      'packages/a': {
        name: 'a',
        peerDependencies: { b: 'workspace:*' },
        devDependencies: { b: 'workspace:*' },
      },
      'packages/b': { name: 'b', version: '1.0.0' },
    });
    expect(dev.edges.map((e) => e.field)).toEqual(['devDependencies']);
  });

  it('keeps a member that lists itself apart from the edges', () => {
    const graph = graphOf({
      '': { name: 'root' },
      'packages/a': { name: 'a', devDependencies: { a: 'workspace:*' } },
    });
    expect(graph.edges).toEqual([]);
    expect(graph.selfEdges.map((e) => e.from)).toEqual(['packages/a']);
  });

  it('points a path specifier at the member in that directory, under either policy', () => {
    for (const policy of ['workspace-protocol', 'satisfied-range'] as const) {
      const graph = graphOf(
        {
          '': { name: 'root' },
          'packages/a': {
            name: 'a',
            dependencies: {
              x: 'link:../b',
              y: 'file:../c',
              z: 'file:../c.tgz',
              w: 'link:../../outside',
            },
          },
          'packages/b': { name: 'b' },
          'packages/c': { name: 'c' },
        },
        policy,
      );
      expect(graph.edges.map((e) => [e.dependency, e.to, e.via])).toEqual([
        ['x', 'packages/b', 'path'],
        ['y', 'packages/c', 'path'],
      ]);
    }
  });
});

describe('the link policy', () => {
  const tree: Tree = {
    '': { name: 'root' },
    'packages/app': {
      name: 'app',
      dependencies: {
        lib: '^1.0.0',
        old: '^0.1.0',
        any: '*',
        none: '*',
        tag: 'latest',
        git: 'git+https://example.test/git.git',
        alias: 'npm:lib@^1.0.0',
      },
    },
    'packages/lib': { name: 'lib', version: '1.4.0' },
    'packages/old': { name: 'old', version: '1.0.0' },
    'packages/any': { name: 'any', version: '5.0.0-rc.1' },
    'packages/none': { name: 'none' },
    'packages/tag': { name: 'tag', version: '1.0.0' },
    'packages/git': { name: 'git', version: '1.0.0' },
  };

  it('links only workspace: and paths when the policy is workspace-protocol (pnpm 9 and later)', () => {
    expect(graphOf(tree, 'workspace-protocol').edges).toEqual([]);
  });

  it('also links a plain range the member satisfies when the policy is satisfied-range (npm)', () => {
    const graph = graphOf(tree, 'satisfied-range');
    expect(edgeNames(graph)).toEqual([
      'app > any > any',
      'app > lib > lib',
      'app > none > none',
    ]);
    expect(graph.edges.every((edge) => edge.via === 'range')).toBe(true);
  });

  it('records the policy it was built under, so a consumer can tell', () => {
    const policies: LinkPolicy[] = ['workspace-protocol', 'satisfied-range'];
    expect(policies.map((p) => graphOf(tree, p).linkPolicy)).toEqual(policies);
  });
});

describe('refusals', () => {
  it('names the specifier and the member when a workspace: member does not exist', () => {
    const run = () =>
      graphOf({
        '': { name: 'root' },
        'packages/a': { name: 'a', dependencies: { ghost: 'workspace:*' } },
      });
    expect(codeOf(run)).toBe('WORKSPACE_SPEC_UNRESOLVED');
    expect(run).toThrowError(
      'a (packages/a) depends on "ghost" as "workspace:*", but no workspace member is named "ghost"',
    );
  });

  it('names the specifier and the member when a form is not supported', () => {
    const run = () =>
      graphOf({
        '': { name: 'root' },
        'packages/a': { name: 'a', devDependencies: { b: 'workspace:latest' } },
        'packages/b': { name: 'b' },
      });
    expect(codeOf(run)).toBe('WORKSPACE_SPEC_UNSUPPORTED');
    expect(run).toThrowError(
      /a \(packages\/a\) devDependencies\["b"\].*"workspace:latest"/u,
    );
  });

  it('refuses a dependency key that cannot name a link', () => {
    const run = () =>
      graphOf({
        '': { name: 'root' },
        'packages/a': {
          name: 'a',
          dependencies: { '../escape': 'workspace:b@*' },
        },
        'packages/b': { name: 'b' },
      });
    expect(codeOf(run)).toBe('WORKSPACE_NAME_INVALID');
    expect(run).toThrowError(/dependency key cannot name a link/u);
  });

  it('does not mind a registry dependency whose key is not a name, which no link is made for', () => {
    expect(() =>
      graphOf({
        '': { name: 'root' },
        'packages/a': { name: 'a', dependencies: { '../x': '^1' } },
      }),
    ).not.toThrow();
  });
});

describe('the real workspaces', () => {
  it('ai-bdd: 9 projects, the 17 links pnpm-lock.yaml records', () => {
    const source = fixture('ai-bdd');
    const graph = graphOf(
      fixtureTree(source),
      'workspace-protocol',
      source.tool,
    );
    expect(graph.members).toHaveLength(9);
    expect(graph.edges).toHaveLength(17);
    expect(graph.edges.every((e) => e.specifier === 'workspace:*')).toBe(true);
    // Two of the 17 are optional peers of packages/cli (peerDependenciesMeta).
    const peers = graph.edges.filter((e) => e.field === 'peerDependencies');
    expect(peers.map((e) => [e.from, e.dependency, e.optional])).toEqual([
      ['packages/cli', '@ai-bdd/driver-playwright', true],
      ['packages/cli', '@ai-bdd/models-ai-sdk', true],
    ]);
  });

  it('ts-autocode: npm links the 5 plain ranges its members satisfy', () => {
    const source = fixture('ts-autocode');
    const graph = graphOf(fixtureTree(source), 'satisfied-range', source.tool);
    expect(graph.members).toHaveLength(5);
    expect(edgeNames(graph).sort()).toEqual(
      [
        'ts-autocode > ts-autocode-grounding > ts-autocode-grounding',
        'ts-autocode > ts-autocode-harness > ts-autocode-harness',
        'ts-autocode > ts-autocode-rewrite > ts-autocode-rewrite',
        'ts-autocode > ts-autocode-training > ts-autocode-training',
        'ts-autocode-training > ts-autocode-rewrite > ts-autocode-rewrite',
      ].sort(),
    );
    // The same repository read as pnpm would, with link-workspace-packages off, links none.
    expect(
      graphOf(fixtureTree(source), 'workspace-protocol', source.tool).edges,
    ).toEqual([]);
  });

  it('gitlang: npm links the 22 plain ranges its members satisfy', () => {
    const source = fixture('gitlang');
    const graph = graphOf(fixtureTree(source), 'satisfied-range', source.tool);
    expect(graph.members).toHaveLength(9);
    expect(graph.edges).toHaveLength(22);
    expect(graph.edges.every((e) => e.via === 'range')).toBe(true);
  });
});
