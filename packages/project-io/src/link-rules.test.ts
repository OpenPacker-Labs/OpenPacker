import { describe, expect, it } from 'vitest';
import {
  MAXIMUM_TARGET_LENGTH,
  linkDirectoryProblem,
  linkNameProblem,
  linkTargetProblem,
  memberLinkProblem,
  splitLinkPath,
} from './link-rules.js';

describe('linkNameProblem', () => {
  it.each(['pkg', 'adapter-npm', 'a.b', 'a_b', 'a~b', 'a+b', 'A1'])(
    'accepts %s',
    (name) => {
      expect(linkNameProblem(name)).toBeUndefined();
    },
  );

  it.each([
    ['', 'empty'],
    ['.bin', 'a leading dot'],
    ['..', 'dot dot'],
    ['.', 'dot'],
    ['node_modules', 'node_modules itself'],
    ['a/b', 'a slash'],
    ['a\\b', 'a backslash'],
    ['a\0b', 'a NUL'],
    ['a b', 'a space'],
    ['@scope', 'a scope, which is a directory and not a package'],
    ['é', 'a non-ASCII letter'],
  ])('refuses %j (%s)', (name) => {
    expect(linkNameProblem(name)).toEqual(expect.any(String));
  });
});

describe('linkDirectoryProblem', () => {
  it.each([
    'node_modules',
    'node_modules/@scope',
    'node_modules/a/node_modules',
    'node_modules/@s/a/node_modules/@t',
    'node_modules/a/node_modules/b/node_modules',
  ])('accepts %s', (directory) => {
    expect(linkDirectoryProblem(directory)).toBeUndefined();
  });

  it.each([
    '',
    '.',
    '/',
    '/node_modules',
    'node_modules/',
    'node_modules/.bin',
    'node_modules/a',
    'node_modules/a/lib',
    'node_modules/@scope/pkg',
    'node_modules/@scope/pkg/lib',
    'node_modules/../x',
    'node_modules/./x',
    'packages/a/node_modules',
    'src',
    '.opm',
    'node_modules\\a',
    'node_modules/@/x',
    'node_modules/@.x',
    'node_modules/@s/@t',
  ])('refuses %j', (directory) => {
    expect(linkDirectoryProblem(directory)).toEqual(expect.any(String));
  });
});

describe('linkTargetProblem', () => {
  const directory = 'node_modules/@scope';

  it.each([
    '../../packages/pkg',
    '../../packages/@scope/pkg',
    '../../a',
    '../../deep/er/member',
  ])('accepts %s from %s', (target) => {
    expect(linkTargetProblem(directory, target)).toBeUndefined();
  });

  it('accepts a shallower link to a nearer member', () => {
    expect(
      linkTargetProblem('node_modules', '../packages/pkg'),
    ).toBeUndefined();
  });

  it.each([
    ['', 'empty'],
    ['/etc', 'absolute'],
    ['/', 'the filesystem root'],
    ['C:/x', 'a drive letter'],
    ['C:x', 'a drive-relative path'],
    ['\\\\server\\share', 'a UNC path'],
    ['..\\..\\a', 'backslashes'],
    ['../../a\0', 'a NUL'],
    ['../../a\n', 'a line break'],
    ['../../a\r', 'a carriage return'],
    ['../../../x', 'a target that leaves the root'],
    ['../../../../etc', 'a target far outside the root'],
    ['../..', 'the project root itself'],
    ['../../.', 'a dot spelling of the root'],
    ['..', 'the parent of the directory'],
    ['../../packages/../..', 'a normal-looking path that leaves the root'],
    ['./../../a', 'a leading dot segment'],
    ['../../a/', 'a trailing slash'],
    ['../../a//b', 'a doubled slash'],
    ['../../a/../b', 'a path that is not normalised'],
    ['../../node_modules/x', 'a registry package'],
    ['../../a/node_modules/b', 'inside a package'],
    ['../../.opm/store/x', "opm's own state"],
    ['../../a'.repeat(MAXIMUM_TARGET_LENGTH), 'an overlong target'],
  ])('refuses %j (%s)', (target) => {
    expect(linkTargetProblem(directory, target)).toEqual(expect.any(String));
  });

  it('names the target and where it goes in every message', () => {
    expect(linkTargetProblem(directory, '../../../x')).toBe(
      'the link target "../../../x" leaves the project root from node_modules/@scope',
    );
    expect(linkTargetProblem(directory, '/etc')).toBe(
      'the link target "/etc" is absolute; a link points inside the project by a relative path',
    );
    expect(linkTargetProblem(directory, '../../node_modules/x')).toBe(
      'the link target "../../node_modules/x" resolves to node_modules/x, which is inside node_modules; only a workspace member\'s own directory may be linked',
    );
    expect(linkTargetProblem(directory, '../../a/../b')).toContain(
      'expected "../../b"',
    );
  });
});

describe('splitLinkPath', () => {
  it('splits a plain and a scoped path', () => {
    expect(splitLinkPath('node_modules/pkg')).toEqual({
      directory: 'node_modules',
      name: 'pkg',
    });
    expect(splitLinkPath('node_modules/@scope/pkg')).toEqual({
      directory: 'node_modules/@scope',
      name: 'pkg',
    });
    expect(splitLinkPath('node_modules/a/node_modules/b')).toEqual({
      directory: 'node_modules/a/node_modules',
      name: 'b',
    });
  });

  it.each([
    'pkg',
    '',
    '/pkg',
    'node_modules/',
    'node_modules/@scope',
    'node_modules/.bin/x',
    'node_modules/a/b',
    'src/pkg',
    'node_modules/pkg/lib/x',
  ])('refuses %j', (path) => {
    expect(splitLinkPath(path)).toHaveProperty('problem');
  });
});

describe('memberLinkProblem', () => {
  it('accepts a member link and refuses a bad place or target', () => {
    expect(
      memberLinkProblem('node_modules/@scope/pkg', '../../packages/pkg'),
    ).toBeUndefined();
    expect(memberLinkProblem('node_modules/.bin/x', '../../x')).toContain(
      'not a node_modules directory',
    );
    expect(memberLinkProblem('node_modules/pkg', '/abs')).toContain('absolute');
  });
});
