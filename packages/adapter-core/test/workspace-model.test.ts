import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WORKSPACE_LIMITS,
  assembleMembers,
  describeMember,
  findDuplicateJsonKey,
  nameFromDirectory,
  parseStrictJson,
  readWorkspaceManifest,
  resolveWorkspaceLimits,
  workspaceNameProblem,
  workspacePatternsOf,
} from '../src/index.js';
import { codeOf, membersOf, sourcesOf } from './workspace-helpers.js';

describe('package names', () => {
  it.each([
    'left-pad',
    '@scope/pkg',
    'Legacy.Name',
    'a_b',
    'tilde~plus+dash-',
    '@a/b.c',
    'ts-autocode-grounding',
  ])('accepts %s', (name) => {
    expect(workspaceNameProblem(name)).toBeUndefined();
  });

  it.each([
    ['', /empty/u],
    ['.hidden', /cannot start/u],
    ['_private', /cannot start/u],
    ['@scope', /not a package name/u],
    ['@/x', /empty scope/u],
    ['@scope/', /empty scope or name/u],
    ['a/b', /not a package name/u],
    ['@a/b/c', /not a package name/u],
    ['node_modules', /reserved/u],
    ['favicon.ico', /reserved/u],
    ['has space', /characters a directory name cannot safely hold/u],
    ['../x', /not a package name/u],
    ['a\\b', /characters a directory name cannot safely hold/u],
    ['a:b', /characters a directory name cannot safely hold/u],
    ['%2e%2e', /characters a directory name cannot safely hold/u],
    ['x'.repeat(215), /longer than 214/u],
  ])('refuses %j', (name, problem) => {
    expect(workspaceNameProblem(name)).toMatch(problem);
  });
});

describe('strict JSON', () => {
  it('reads a manifest and drops a byte-order mark', () => {
    expect(parseStrictJson('﻿{"a":1}', 'package.json')).toEqual({ a: 1 });
  });

  it('refuses a document that is not JSON', () => {
    expect(() =>
      parseStrictJson('{"a":', 'packages/a/package.json'),
    ).toThrowError(/packages\/a\/package\.json is not valid JSON/u);
  });

  it.each([
    ['{"name":"a","name":"b"}', 'name'],
    ['{"dependencies":{"x":"1","x":"2"}}', 'x'],
    ['{"a":[{"k":1,"k":2}]}', 'k'],
    ['{"a":1,"\\u0061":2}', 'a'],
    ['{"o":{"a":1},"p":{"a":1},"a":0,"a":1}', 'a'],
  ])('refuses a repeated key in %s', (text, key) => {
    expect(findDuplicateJsonKey(text)).toBe(key);
    expect(codeOf(() => parseStrictJson(text, 'package.json'))).toBe(
      'WORKSPACE_MANIFEST_INVALID',
    );
  });

  it.each([
    '{"a":{"b":1},"c":{"b":2}}',
    '{"a":[1,2,{"b":1},{"b":2}]}',
    '{"s":"{\\"a\\":1,\\"a\\":2}","a":1}',
    '{"a":"x","b":"x"}',
    '[{"a":1},{"a":2}]',
  ])('accepts the same key in different objects: %s', (text) => {
    expect(findDuplicateJsonKey(text)).toBeUndefined();
  });
});

describe('manifest reading', () => {
  const read = (value: Parameters<typeof readWorkspaceManifest>[0]) =>
    readWorkspaceManifest(
      value,
      'packages/a/package.json',
      DEFAULT_WORKSPACE_LIMITS,
    );

  it('keeps what the model needs and nothing else', () => {
    const manifest = read({
      name: '@s/a',
      version: '1.0.0',
      private: true,
      scripts: { build: 'x' },
      dependencies: { b: 'workspace:*' },
      peerDependencies: { c: '^1' },
      peerDependenciesMeta: { c: { optional: true }, d: {} },
      workspaces: ['packages/*'],
    });
    expect(manifest.name).toBe('@s/a');
    expect(manifest.private).toBe(true);
    expect([...manifest.dependencies]).toEqual([['b', 'workspace:*']]);
    expect([...manifest.optionalPeers]).toEqual(['c']);
    expect(manifest.workspaces).toEqual(['packages/*']);
    expect('scripts' in manifest).toBe(false);
    expect('publishDirectory' in manifest).toBe(false);
  });

  it('keeps publishConfig.directory, which pnpm links a member from', () => {
    expect(
      read({ publishConfig: { directory: 'dist' } }).publishDirectory,
    ).toBe('dist');
    for (const publishConfig of [
      { access: 'public' },
      { directory: 1 },
      'dist',
    ])
      expect('publishDirectory' in read({ publishConfig })).toBe(false);
  });

  it.each([
    [[], 'must be a JSON object'],
    [{ name: 1 }, 'name must be a string'],
    [{ version: 1 }, 'version must be a string'],
    [{ dependencies: [] }, 'dependencies must be an object'],
    [
      { devDependencies: { a: 1 } },
      'devDependencies["a"] must be a string specifier',
    ],
    [{ peerDependenciesMeta: [] }, 'peerDependenciesMeta must be an object'],
  ])('refuses %j', (value, problem) => {
    expect(() => read(value)).toThrowError(problem);
  });

  it('bounds a dependency list', () => {
    const dependencies = Object.fromEntries(
      Array.from({ length: 4 }, (_, at) => [`d${at}`, '1']),
    );
    expect(() =>
      readWorkspaceManifest(
        { dependencies },
        'package.json',
        resolveWorkspaceLimits({ maxDependencyEntries: 3 }),
      ),
    ).toThrowError(/lists 4 entries, more than the limit of 3/u);
  });

  it('reads both spellings of a workspaces declaration and refuses the rest', () => {
    expect(workspacePatternsOf(['a/*', 'b'], 'package.json')).toEqual([
      'a/*',
      'b',
    ]);
    expect(
      workspacePatternsOf(
        { packages: ['a/*'], nohoist: ['**'] },
        'package.json',
      ),
    ).toEqual(['a/*']);
    for (const bad of ['a/*', { packages: 'a/*' }, [1], { nohoist: [] }, null])
      expect(codeOf(() => workspacePatternsOf(bad, 'package.json'))).toBe(
        'WORKSPACE_DECLARATION_INVALID',
      );
  });
});

describe('limits', () => {
  it('has defaults well above the largest workspace measured (792 members)', () => {
    expect(DEFAULT_WORKSPACE_LIMITS.maxMembers).toBeGreaterThan(792 * 5);
  });

  it('refuses a limit that is not a positive integer or is past its ceiling', () => {
    for (const value of [0, -1, 1.5, Number.NaN, 1e12])
      expect(codeOf(() => resolveWorkspaceLimits({ maxMembers: value }))).toBe(
        'WORKSPACE_LIMIT_EXCEEDED',
      );
  });

  it('overrides one limit and keeps the rest', () => {
    const limits = resolveWorkspaceLimits({ maxDepth: 3 });
    expect(limits.maxDepth).toBe(3);
    expect(limits.maxMembers).toBe(DEFAULT_WORKSPACE_LIMITS.maxMembers);
  });
});

describe('members', () => {
  it('orders the root first and the rest by directory, whatever order they were found in', () => {
    const members = membersOf({
      'packages/b': { name: 'b' },
      '': { name: 'root' },
      'apps/z': { name: 'z' },
      'packages/a': { name: 'a' },
    });
    expect(members.map((m) => m.dir)).toEqual([
      '',
      'apps/z',
      'packages/a',
      'packages/b',
    ]);
    expect(members[0]?.root).toBe(true);
  });

  it('names two members with one name, and both paths', () => {
    const run = () =>
      membersOf({
        '': {},
        'packages/a': { name: 'x' },
        'tools/a': { name: 'x' },
      });
    expect(codeOf(run)).toBe('WORKSPACE_NAME_DUPLICATE');
    expect(run).toThrowError(
      'Two workspace members are named "x": packages/a and tools/a',
    );
  });

  it('counts the root among the names', () => {
    expect(
      codeOf(() =>
        membersOf({ '': { name: 'x' }, 'packages/a': { name: 'x' } }),
      ),
    ).toBe('WORKSPACE_NAME_DUPLICATE');
  });

  it('refuses a name that is not a package name, naming the directory', () => {
    expect(() =>
      membersOf({ '': {}, 'packages/a': { name: '../evil' } }),
    ).toThrowError(/packages\/a: "\.\.\/evil" is not a package name/u);
    expect(
      codeOf(() => membersOf({ '': {}, 'packages/a': { name: 'a b' } })),
    ).toBe('WORKSPACE_NAME_INVALID');
  });

  it('leaves a nameless member nameless under pnpm and names it for its directory under npm', () => {
    const tree = { '': { name: 'r' }, 'packages/a': {}, 'packages/@s/b': {} };
    const pnpm = membersOf(tree, 'pnpm');
    expect(pnpm.map((m) => m.name)).toEqual(['r', undefined, undefined]);
    const npm = membersOf(tree, 'npm');
    expect(npm.map((m) => [m.name, m.nameFromDirectory])).toEqual([
      ['r', false],
      ['@s/b', true],
      ['a', true],
    ]);
  });

  it('never names the root for its directory', () => {
    expect(membersOf({ '': {} }, 'npm')[0]?.name).toBeUndefined();
  });

  it('refuses a directory twice and more members than the limit', () => {
    const sources = sourcesOf({ '': {}, a: {} });
    expect(
      codeOf(() =>
        assembleMembers(
          [...sources, ...sources],
          'pnpm',
          DEFAULT_WORKSPACE_LIMITS,
        ),
      ),
    ).toBe('WORKSPACE_NAME_DUPLICATE');
    expect(
      codeOf(() =>
        assembleMembers(
          sources,
          'pnpm',
          resolveWorkspaceLimits({ maxMembers: 1 }),
        ),
      ),
    ).toBe('WORKSPACE_LIMIT_EXCEEDED');
  });

  it('derives a name from a directory the way npm does', () => {
    expect(nameFromDirectory('packages/a')).toBe('a');
    expect(nameFromDirectory('packages/@s/a')).toBe('@s/a');
    expect(nameFromDirectory('')).toBeUndefined();
  });

  it('shows a member by name and place', () => {
    expect(describeMember({ dir: 'p/a', name: 'a' })).toBe('a (p/a)');
    expect(describeMember({ dir: '', name: 'r' })).toBe('r (root)');
    expect(describeMember({ dir: 'p/a', name: undefined })).toBe('p/a');
  });
});
