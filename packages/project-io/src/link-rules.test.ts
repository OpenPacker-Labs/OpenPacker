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
    [
      'NODE_MODULES',
      'node_modules in capitals, the same directory on a volume that ignores case',
    ],
    ['Node_Modules', 'node_modules in mixed case'],
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
    'node_modules/@NODE_MODULES',
    'node_modules/NODE_MODULES/node_modules',
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

describe('linkTargetProblem and the names a volume gives the same directory', () => {
  const directory = 'node_modules/@scope';
  const platforms = ['linux', 'darwin', 'win32'] as const;

  it.each([
    ['../../NODE_MODULES/left-pad', 'capitals'],
    ['../../Node_Modules/left-pad', 'mixed case'],
    ['../../a/NODE_MODULES/b', 'inside a package, in capitals'],
    ['../../.OPM/store', '.opm in capitals'],
    ['../../.Opm/store/x', '.opm in mixed case'],
    ['../../node_modules./left-pad', 'a trailing dot, which Windows drops'],
    ['../../node_modules /left-pad', 'a trailing space, which Windows drops'],
    [
      '../../node_modules::$INDEX_ALLOCATION/x',
      'a stream name, which Windows drops',
    ],
    ['../../.opm./store', '.opm with a trailing dot'],
  ])('refuses %j (%s) on every platform', (target) => {
    for (const platform of platforms)
      expect(
        linkTargetProblem(directory, target, platform),
        `linkTargetProblem(${JSON.stringify(directory)}, ${JSON.stringify(target)}, ${JSON.stringify(platform)})`,
      ).toEqual(expect.any(String));
  });

  it('says which spelling it refused, and keeps the message for the exact one', () => {
    expect(linkTargetProblem(directory, '../../NODE_MODULES/x')).toBe(
      'the link target "../../NODE_MODULES/x" resolves to NODE_MODULES/x, which is inside node_modules (spelled "NODE_MODULES", which is the same directory on a volume that ignores case); only a workspace member\'s own directory may be linked',
    );
    expect(linkTargetProblem(directory, '../../node_modules/x')).toBe(
      'the link target "../../node_modules/x" resolves to node_modules/x, which is inside node_modules; only a workspace member\'s own directory may be linked',
    );
  });

  it.each([
    ['../../NODE_M~1/left-pad', "node_modules' short name"],
    ['../../OPM~1/store', 'the short name of .opm'],
    ['../../PACKAG~1/member', 'a short name for any directory'],
    ['../../packages/member~12', 'a short name with two digits'],
    ['../../packages/MEMBER~1.JS', 'a short name with an extension'],
  ])('refuses %j (%s) on Windows only', (target) => {
    expect(
      linkTargetProblem(directory, target, 'win32'),
      `linkTargetProblem(${JSON.stringify(directory)}, ${JSON.stringify(target)}, "win32")`,
    ).toContain('8.3 short name');
    for (const platform of ['linux', 'darwin'] as const)
      expect(
        linkTargetProblem(directory, target, platform),
        `linkTargetProblem(${JSON.stringify(directory)}, ${JSON.stringify(target)}, ${JSON.stringify(platform)})`,
      ).toBeUndefined();
  });

  it('uses the platform it runs on when none is given, and memberLinkProblem passes it on', () => {
    expect(linkTargetProblem(directory, '../../PACKAG~1/x')).toBe(
      linkTargetProblem(directory, '../../PACKAG~1/x', process.platform),
    );
    expect(
      memberLinkProblem('node_modules/@scope/pkg', '../../PACKAG~1/x', 'win32'),
    ).toContain('8.3 short name');
    expect(
      memberLinkProblem('node_modules/@scope/pkg', '../../PACKAG~1/x', 'linux'),
    ).toBeUndefined();
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
