import { describe, expect, it } from 'vitest';
import {
  indexMembers,
  isStrictVersion,
  npmRangeEngine,
  parseWorkspaceSpec,
  publishedDependencies,
  resolveRelativeDirectory,
  resolveWorkspaceSpec,
  type DependencyField,
} from '../src/index.js';
import { codeOf, membersOf } from './workspace-helpers.js';
import { graphOf } from './workspace-graph-helpers.js';

describe('the range engine', () => {
  // [version, range, satisfies]: every row was put to semver 7.7's
  // satisfies(version, range, true), the call npm's own dependency check makes.
  it.each([
    ['1.2.3', '*', true],
    ['1.2.3-beta.1', '*', true],
    ['1.2.3', '', true],
    ['1.2.3', 'x', true],
    ['1.5.0', '1.x', true],
    ['2.0.0', '1.x', false],
    ['1.2.9', '1.2.x', true],
    ['1.2.3', '^1.2.3', true],
    ['1.9.9', '^1.2.3', true],
    ['2.0.0', '^1.2.3', false],
    ['1.2.2', '^1.2.3', false],
    ['0.1.5', '^0.1.0', true],
    ['0.2.0', '^0.1.0', false],
    ['0.0.2', '^0.0.1', false],
    ['1.2.9', '~1.2.3', true],
    ['1.3.0', '~1.2.3', false],
    ['1.2.3', '1.2.3', true],
    ['1.2.3', '=1.2.3', true],
    ['1.2.3', 'v1.2.3', true],
    ['1.2.4', '1.2.3', false],
    ['1.5.0', '>=1.0.0 <2.0.0', true],
    ['2.0.0', '>=1.0.0 <2.0.0', false],
    ['2.0.0', '1.0.0 - 2.0.0', true],
    ['2.1.0', '^1.0.0 || ^2.0.0', true],
    ['3.0.0', '^1.0.0 || ^2.0.0', false],
    ['1.0.0-beta.1', '^1.0.0', false],
    ['1.2.3-rc.1', '^1.2.3-rc.1', true],
    ['1.2.3-rc.2', '^1.2.3-rc.1', true],
    ['1.2.4-rc.1', '^1.2.3-rc.1', false],
    ['10.0.0', '>=2.0.0', true],
    ['1.9.0', '>=2.0.0', false],
  ] as const)('%s against %j is %s', (version, range, expected) => {
    expect(npmRangeEngine.satisfies(version, range)).toBe(expected);
  });

  it.each([
    'latest',
    'next',
    'git+https://example.test/x.git',
    'file:../x',
    'npm:foo@1',
  ])('does not take %j for a range', (text) => {
    expect(npmRangeEngine.satisfies('1.0.0', text)).toBeUndefined();
  });

  it('orders versions', () => {
    expect(npmRangeEngine.compareVersions('1.2.3', '1.10.0')).toBe(-1);
    expect(npmRangeEngine.compareVersions('1.0.0-beta', '1.0.0')).toBe(-1);
    expect(npmRangeEngine.compareVersions('2.0.0', '2.0.0+build')).toBe(0);
  });

  it('knows a strict version from a lenient one', () => {
    for (const ok of ['0.0.0', '1.2.3', '1.2.3-rc.1', '1.2.3+b.1', '10.20.30'])
      expect(isStrictVersion(ok), ok).toBe(true);
    for (const bad of [
      '1.2',
      'v1.2.3',
      '01.2.3',
      '1.2.3.4',
      '',
      'latest',
      '1.2.3-',
      '1.2.3-01',
    ])
      expect(isStrictVersion(bad), bad).toBe(false);
  });
});

describe('parsing workspace: specifiers', () => {
  const parse = (written: string) =>
    parseWorkspaceSpec(written, 'a dependencies["b"]', npmRangeEngine);

  it.each([
    [
      'workspace:*',
      { kind: 'range', alias: undefined, range: { mode: 'any', token: '*' } },
    ],
    [
      'workspace:^',
      { kind: 'range', alias: undefined, range: { mode: 'any', token: '^' } },
    ],
    [
      'workspace:~',
      { kind: 'range', alias: undefined, range: { mode: 'any', token: '~' } },
    ],
    [
      'workspace:1.2.3',
      {
        kind: 'range',
        alias: undefined,
        range: { mode: 'semver', text: '1.2.3' },
      },
    ],
    [
      'workspace:^1.2.3',
      {
        kind: 'range',
        alias: undefined,
        range: { mode: 'semver', text: '^1.2.3' },
      },
    ],
    [
      'workspace:>=1.0.0 <2',
      {
        kind: 'range',
        alias: undefined,
        range: { mode: 'semver', text: '>=1.0.0 <2' },
      },
    ],
    [
      'workspace:other@*',
      { kind: 'range', alias: 'other', range: { mode: 'any', token: '*' } },
    ],
    [
      'workspace:@s/other@^1.0.0',
      {
        kind: 'range',
        alias: '@s/other',
        range: { mode: 'semver', text: '^1.0.0' },
      },
    ],
    ['workspace:../b', { kind: 'path', path: '../b' }],
    ['workspace:./b', { kind: 'path', path: './b' }],
    ['workspace:..', { kind: 'path', path: '..' }],
    ['workspace:.', { kind: 'path', path: '.' }],
    // A path may hold an "@": pnpm's alias pattern cannot start with a dot.
    ['workspace:../x@1', { kind: 'path', path: '../x@1' }],
  ])('reads %s', (written, expected) => {
    expect(parse(written)).toMatchObject(expected);
  });

  it.each([
    ['workspace:', /names no version/u],
    ['workspace:latest', /not a version range/u],
    ['workspace:next', /not a version range/u],
    ['workspace:git+https://x/y.git', /not a version range/u],
    ['workspace:/abs/path', /absolute path leaves the workspace/u],
    ['workspace:other@', /names no version/u],
    ['workspace:_x@1.0.0', /not a version range/u],
    ['workspace:a b@1.0.0', /alias is not a package name/u],
    ['workspace:other@../b', /a path cannot carry an alias/u],
    ['workspace:other@./b', /a path cannot carry an alias/u],
    ['npm:foo@1', /not a workspace: form/u],
  ])('refuses %s, naming the specifier and the member', (written, reason) => {
    const run = () => parse(written);
    expect(codeOf(run)).toBe('WORKSPACE_SPEC_UNSUPPORTED');
    expect(run).toThrowError(reason);
    expect(run).toThrowError(JSON.stringify(written));
    expect(run).toThrowError('a dependencies["b"]');
  });
});

describe('resolving workspace: specifiers', () => {
  const members = membersOf({
    '': { name: 'root' },
    'packages/a': { name: 'a', version: '1.0.0' },
    'packages/b': { name: 'b', version: '1.2.3' },
    'packages/c': { name: 'c' },
    'packages/pre': { name: 'pre', version: '2.0.0-rc.1' },
  });
  const index = indexMembers(members);
  const from = members.find((m) => m.dir === 'packages/a')!;
  const resolve = (written: string, key = 'b') =>
    resolveWorkspaceSpec(
      parseWorkspaceSpec(written, 'a', npmRangeEngine),
      key,
      from,
      index,
      npmRangeEngine,
    ).dir;

  it('finds the member by the dependency key', () => {
    for (const spec of [
      'workspace:*',
      'workspace:^',
      'workspace:~',
      'workspace:1.2.3',
      'workspace:^1.0.0',
      'workspace:1.x',
    ])
      expect(resolve(spec), spec).toBe('packages/b');
  });

  it('takes any version for * ^ ~, prereleases and a missing version included', () => {
    expect(resolve('workspace:*', 'pre')).toBe('packages/pre');
    expect(resolve('workspace:^', 'pre')).toBe('packages/pre');
    expect(resolve('workspace:*', 'c')).toBe('packages/c');
  });

  it('counts a package with no version as 0.0.0, as pnpm installs it', () => {
    expect(resolve('workspace:0.0.0', 'c')).toBe('packages/c');
    expect(codeOf(() => resolve('workspace:^1.0.0', 'c'))).toBe(
      'WORKSPACE_SPEC_UNRESOLVED',
    );
  });

  it('finds the member by the alias, whatever the key', () => {
    expect(resolve('workspace:b@*', 'my-alias')).toBe('packages/b');
    expect(resolve('workspace:b@^1.2.0', 'my-alias')).toBe('packages/b');
  });

  it('finds the member by directory, from the dependent', () => {
    expect(resolve('workspace:../b', 'whatever')).toBe('packages/b');
    expect(resolve('workspace:../../packages/b', 'x')).toBe('packages/b');
    expect(resolve('workspace:../..', 'x')).toBe('');
    expect(resolve('workspace:.', 'x')).toBe('packages/a');
  });

  it.each([
    ['workspace:*', 'missing', /no workspace member is named "missing"/u],
    ['workspace:other@*', 'b', /no workspace member is named "other"/u],
    [
      'workspace:^2.0.0',
      'b',
      /b \(packages\/b\) is at version 1\.2\.3, which does not satisfy \^2\.0\.0/u,
    ],
    ['workspace:1.2.4', 'b', /does not satisfy 1\.2\.4/u],
    [
      'workspace:../nowhere',
      'b',
      /no workspace member lives at packages\/nowhere/u,
    ],
    ['workspace:../../..', 'b', /leaves the workspace root/u],
  ])('refuses %s for %s, naming both', (written, key, reason) => {
    const run = () => resolve(written, key);
    expect(codeOf(run)).toBe('WORKSPACE_SPEC_UNRESOLVED');
    expect(run).toThrowError(reason);
    expect(run).toThrowError(
      `a (packages/a) depends on "${key}" as ${JSON.stringify(written)}`,
    );
  });

  it('joins a path to a directory without leaving the root', () => {
    expect(resolveRelativeDirectory('packages/a', '../b')).toBe('packages/b');
    expect(resolveRelativeDirectory('', 'x/./y')).toBe('x/y');
    expect(resolveRelativeDirectory('a', '../..')).toBeUndefined();
    expect(resolveRelativeDirectory('', '..')).toBeUndefined();
  });
});

describe('the published form', () => {
  const tree = (field: DependencyField, key: string, written: string) => ({
    '': { name: 'root' },
    'packages/a': { name: 'a', version: '1.0.0', [field]: { [key]: written } },
    'packages/b': { name: 'b', version: '1.2.3' },
    'packages/other-c': { name: 'other', version: '4.5.6' },
  });
  const published = (field: DependencyField, key: string, written: string) =>
    publishedDependencies(
      graphOf(tree(field, key, written)),
      'packages/a',
      npmRangeEngine,
    )[field].get(key);

  // Each row is what pnpm's own converter returned for the same dependency, run
  // over the same layout (b at 1.2.3; "other" at 4.5.6, in a directory of
  // another name): `replaceWorkspaceProtocol` for the first three lists,
  // `replaceWorkspaceProtocolPeerDependency` for peers.
  it.each([
    ['b', 'workspace:*', '1.2.3'],
    ['b', 'workspace:^', '^1.2.3'],
    ['b', 'workspace:~', '~1.2.3'],
    ['b', 'workspace:^1.2.3', '^1.2.3'],
    ['b', 'workspace:1.2.3', '1.2.3'],
    ['b', 'workspace:~1.2.0', '~1.2.0'],
    ['b', 'workspace:>=1.0.0', '>=1.0.0'],
    ['b', 'workspace:1.x', '1.x'],
    ['b', 'workspace:../b', '1.2.3'],
    ['c', 'workspace:other@*', 'npm:other@4.5.6'],
    ['c', 'workspace:other@^', 'npm:other@^4.5.6'],
    ['c', 'workspace:other@~', 'npm:other@~4.5.6'],
    ['c', 'workspace:other@^4.0.0', 'npm:other@^4.0.0'],
    ['c', 'workspace:other@4.5.6', 'npm:other@4.5.6'],
    ['c', 'workspace:../other-c', 'npm:other@4.5.6'],
  ])('publishes dependencies[%s] %s as %s', (key, written, expected) => {
    expect(published('dependencies', key, written)).toBe(expected);
    expect(published('devDependencies', key, written)).toBe(expected);
    expect(published('optionalDependencies', key, written)).toBe(expected);
  });

  it.each([
    ['workspace:^', '^1.2.3'],
    ['workspace:*', '1.2.3'],
    ['workspace:^1.2.3', '^1.2.3'],
    ['workspace:>=1.0.0', '>=1.0.0'],
  ])('publishes peerDependencies[b] %s as %s', (written, expected) => {
    expect(published('peerDependencies', 'b', written)).toBe(expected);
  });

  it('refuses the peer forms pnpm mangles or leaves half-rewritten', () => {
    expect(
      codeOf(() =>
        published(
          'peerDependencies',
          'b',
          'workspace:^1.0.0 || workspace:^2.0.0',
        ),
      ),
    ).toBe('WORKSPACE_SPEC_UNSUPPORTED');
  });

  it('refuses a peer written as a path or with an alias, which pnpm rewrites as text', () => {
    for (const [key, written] of [
      ['b', 'workspace:../b'],
      ['c', 'workspace:other@*'],
      ['c', 'workspace:other@^4.0.0'],
    ] as const) {
      const run = () => published('peerDependencies', key, written);
      expect(codeOf(run), written).toBe('WORKSPACE_SPEC_UNSUPPORTED');
      expect(run, written).toThrowError(/cannot be rewritten for publication/u);
    }
    // The same forms are rewritten properly in the lists pnpm handles properly.
    expect(published('dependencies', 'b', 'workspace:../b')).toBe('1.2.3');
    expect(published('dependencies', 'c', 'workspace:other@*')).toBe(
      'npm:other@4.5.6',
    );
  });

  it('leaves every other specifier as written', () => {
    expect(published('dependencies', 'b', '^1.0.0')).toBe('^1.0.0');
    expect(published('dependencies', 'zlib', 'npm:other@1')).toBe(
      'npm:other@1',
    );
  });

  it('cannot publish against a member with no version or no name', () => {
    const graph = graphOf({
      '': { name: 'root' },
      'packages/a': { name: 'a', dependencies: { b: 'workspace:*' } },
      'packages/b': { name: 'b' },
    });
    expect(() =>
      publishedDependencies(graph, 'packages/a', npmRangeEngine),
    ).toThrowError(
      /cannot be published because b \(packages\/b\) has no version/u,
    );
    const nameless = graphOf({
      '': { name: 'root' },
      'packages/a': { name: 'a', dependencies: { b: 'workspace:../b' } },
      'packages/b': { version: '1.0.0' },
    });
    expect(() =>
      publishedDependencies(nameless, 'packages/a', npmRangeEngine),
    ).toThrowError(/packages\/b has no name/u);
  });

  it('rewrites a key listed in two lists in both', () => {
    const graph = graphOf({
      '': { name: 'root' },
      'packages/a': {
        name: 'a',
        dependencies: { b: 'workspace:^' },
        devDependencies: { b: 'workspace:*' },
      },
      'packages/b': { name: 'b', version: '1.2.3' },
    });
    const lists = publishedDependencies(graph, 'packages/a', npmRangeEngine);
    expect(lists.dependencies.get('b')).toBe('^1.2.3');
    expect(lists.devDependencies.get('b')).toBe('1.2.3');
  });

  it('rewrites a member that lists itself', () => {
    const graph = graphOf({
      '': { name: 'root' },
      'packages/a': {
        name: 'a',
        version: '3.0.0',
        devDependencies: { a: 'workspace:*' },
      },
    });
    expect(
      publishedDependencies(
        graph,
        'packages/a',
        npmRangeEngine,
      ).devDependencies.get('a'),
    ).toBe('3.0.0');
  });
});
