import { describe, expect, it } from 'vitest';
import {
  chainOfLockPath,
  findDuplicateJsonKey,
  parsePackageLockText,
  readPackageLock,
  resolveFromChain,
} from './lock-tree.js';

const registry = (
  name: string,
  version: string,
  extra: Record<string, unknown> = {},
) => ({
  version,
  resolved: `https://registry.npmjs.org/${name}/-/${name.split('/').at(-1)}-${version}.tgz`,
  integrity: 'sha512-AAAA',
  ...extra,
});

const lock = (packages: Record<string, unknown>, lockfileVersion = 3) => ({
  name: 'app',
  version: '1.0.0',
  lockfileVersion,
  packages,
});

describe('chainOfLockPath', () => {
  it('reads nested and scoped paths into directory names', () => {
    expect(chainOfLockPath('node_modules/a')).toEqual(['a']);
    expect(chainOfLockPath('node_modules/@s/n')).toEqual(['@s/n']);
    expect(
      chainOfLockPath('node_modules/a/node_modules/@s/n/node_modules/b'),
    ).toEqual(['a', '@s/n', 'b']);
  });

  it('says nothing about a key outside node_modules', () => {
    expect(chainOfLockPath('packages/member')).toBeUndefined();
    expect(chainOfLockPath('packages/member/node_modules/x')).toBeUndefined();
  });

  it('refuses a key that starts in node_modules and is not a clean chain', () => {
    for (const bad of [
      'node_modules/',
      'node_modules/a/b',
      'node_modules/@scope',
      'node_modules/a//node_modules/b',
      'node_modules/a/node_modules/',
      'node_modules/.bin',
      'node_modules/..',
      'node_modules/a b',
    ])
      expect(() => chainOfLockPath(bad), bad).toThrow(/lock path/u);
  });
});

describe('findDuplicateJsonKey', () => {
  it('finds a key repeated in one object', () => {
    expect(findDuplicateJsonKey('{"a":1,"b":{"c":1},"a":2}')).toBe('a');
    expect(findDuplicateJsonKey('{"x":{"a":1,"a":2}}')).toBe('a');
  });

  it('sees through escapes', () => {
    expect(findDuplicateJsonKey('{"ab":1,"a\\u0062":2}')).toBe('ab');
  });

  it('allows the same key in different objects and in arrays', () => {
    expect(
      findDuplicateJsonKey('{"a":1,"b":[{"a":1},{"a":2}],"c":{"a":3}}'),
    ).toBeUndefined();
  });

  it('does not read a string value as a key', () => {
    expect(
      findDuplicateJsonKey('{"a":"a","b":"a","c":["a","a"]}'),
    ).toBeUndefined();
    expect(findDuplicateJsonKey('{"a":"x,\\"a\\":y","b":1}')).toBeUndefined();
  });
});

describe('readPackageLock', () => {
  it('classifies the root, packages, links and workspace members', () => {
    const tree = readPackageLock(
      lock({
        '': {
          name: 'app',
          version: '1.0.0',
          dependencies: { a: '^1.0.0' },
          devDependencies: { t: '^1.0.0' },
          workspaces: ['packages/*'],
        },
        'node_modules/t': registry('t', '1.0.0', { dev: true }),
        'node_modules/a': registry('a', '1.0.0'),
        'node_modules/a/node_modules/c': registry('c', '2.0.0'),
        'node_modules/member': { resolved: 'packages/member', link: true },
        'packages/member': { name: 'member', version: '0.1.0' },
        'packages/member/node_modules/x': registry('x', '1.0.0'),
      }),
    );
    expect(tree.root).toMatchObject({
      name: 'app',
      dependencies: { a: '^1.0.0' },
      devDependencies: { t: '^1.0.0' },
      workspaces: ['packages/*'],
    });
    expect(tree.entries.map((entry) => entry.path)).toEqual([
      'node_modules/a',
      'node_modules/a/node_modules/c',
      'node_modules/t',
    ]);
    expect(tree.links).toEqual([
      { path: 'node_modules/member', target: 'packages/member' },
    ]);
    expect(tree.foreign.map((entry) => entry.path)).toEqual([
      'packages/member',
      'packages/member/node_modules/x',
    ]);
  });

  it('reads flags, platform lists and an aliased name', () => {
    const [entry] = readPackageLock(
      lock({
        '': { name: 'app' },
        'node_modules/cjs': registry('string-width', '4.2.3', {
          name: 'string-width',
          dev: true,
          optional: true,
          devOptional: true,
          peer: true,
          inBundle: true,
          hasInstallScript: true,
          deprecated: 'use something else',
          os: ['linux'],
          cpu: 'x64',
          libc: ['glibc'],
          peerDependencies: { react: '*' },
          peerDependenciesMeta: { react: { optional: true } },
        }),
      }),
    ).entries;
    expect(entry).toMatchObject({
      name: 'cjs',
      packageName: 'string-width',
      dev: true,
      optional: true,
      devOptional: true,
      peer: true,
      inBundle: true,
      hasInstallScript: true,
      deprecated: 'use something else',
      os: ['linux'],
      cpu: ['x64'],
      libc: ['glibc'],
      peerDependencies: { react: '*' },
      peerDependenciesMeta: { react: { optional: true } },
    });
  });

  it('is the same however the file is ordered', () => {
    const a = lock({
      '': {},
      'node_modules/b': registry('b', '1.0.0'),
      'node_modules/a': registry('a', '1.0.0'),
    });
    const b = lock({
      '': {},
      'node_modules/a': registry('a', '1.0.0'),
      'node_modules/b': registry('b', '1.0.0'),
    });
    expect(readPackageLock(a)).toEqual(readPackageLock(b));
  });

  it('accepts lockfileVersion 2 and 3 and refuses the rest', () => {
    expect(readPackageLock(lock({ '': {} }, 2)).lockfileVersion).toBe(2);
    expect(readPackageLock(lock({ '': {} }, 3)).lockfileVersion).toBe(3);
    expect(() => readPackageLock(lock({ '': {} }, 1))).toThrow(
      /lockfileVersion 1/u,
    );
    expect(() => readPackageLock({ packages: {} })).toThrow(
      /lockfileVersion 1/u,
    );
    expect(() => readPackageLock(lock({ '': {} }, 4))).toThrow(
      /v2 or v3, received 4/u,
    );
  });

  it('refuses a lock it cannot read faithfully', () => {
    expect(() => readPackageLock([])).toThrow(/JSON object/u);
    expect(() => readPackageLock({ lockfileVersion: 3 })).toThrow(/packages/u);
    expect(() =>
      readPackageLock(lock({ 'node_modules/a': { resolved: 'x' } })),
    ).toThrow(/version must be a non-empty string/u);
    expect(() =>
      readPackageLock(
        lock({ 'node_modules/a': { version: '1.0.0', dev: 'yes' } }),
      ),
    ).toThrow(/dev must be true or false/u);
    expect(() =>
      readPackageLock(
        lock({ 'node_modules/a': { version: '1.0.0', os: [1] } }),
      ),
    ).toThrow(/os must be a list of strings/u);
    expect(() =>
      readPackageLock(
        lock({
          'node_modules/a': { version: '1.0.0', dependencies: { b: 1 } },
        }),
      ),
    ).toThrow(/dependencies\.b must be a string/u);
    for (const path of ['../x', '/etc', 'a\\b', 'packages/./x', 'packages//x'])
      expect(() =>
        readPackageLock(lock({ [path]: { version: '1.0.0' } })),
      ).toThrow(/relative path inside the project/u);
  });

  it('refuses a lock that is far larger than any project', () => {
    const packages: Record<string, unknown> = { '': {} };
    for (let index = 0; index < 50_001; index += 1)
      packages[`node_modules/p${index}`] = { version: '1.0.0' };
    expect(() => readPackageLock(lock(packages))).toThrow(
      /more than the 50000/u,
    );
  });
});

describe('parsePackageLockText', () => {
  it('parses text and refuses a path listed twice', () => {
    const text = JSON.stringify(
      lock({ '': {}, 'node_modules/a': registry('a', '1.0.0') }),
    );
    expect(parsePackageLockText(text).entries).toHaveLength(1);
    expect(() =>
      parsePackageLockText(
        text.replace(
          '"node_modules/a":',
          '"node_modules/a":{"version":"9.9.9"},"node_modules/a":',
        ),
      ),
    ).toThrow(/lists the key "node_modules\/a" twice/u);
    expect(() => parsePackageLockText('{')).toThrow(/not valid JSON/u);
  });
});

describe('resolveFromChain', () => {
  const tree = readPackageLock(
    lock({
      '': {},
      'node_modules/a': registry('a', '1.0.0'),
      'node_modules/c': registry('c', '1.0.0'),
      'node_modules/a/node_modules/c': registry('c', '2.0.0'),
      'node_modules/@s/n': registry('@s/n', '1.0.0'),
    }),
  );
  const byPath = new Map(tree.entries.map((entry) => [entry.path, entry]));

  it('finds the nearest node_modules, as Node does', () => {
    expect(resolveFromChain(byPath, ['a'], 'c')?.version).toBe('2.0.0');
    expect(resolveFromChain(byPath, ['@s/n'], 'c')?.version).toBe('1.0.0');
    expect(resolveFromChain(byPath, [], 'c')?.version).toBe('1.0.0');
    expect(resolveFromChain(byPath, ['a'], '@s/n')?.version).toBe('1.0.0');
    expect(resolveFromChain(byPath, ['a'], 'missing')).toBeUndefined();
  });
});
