import { describe, expect, it } from 'vitest';
import { PnpmLockError } from './errors.js';
import { DEFAULT_PNPM_LOCK_LIMITS } from './limits.js';
import { parseRef } from './ref.js';
import {
  classifyVersion,
  insidePathProblem,
  integrityProblem,
  isSemver,
  relativePathProblem,
  tarballUrlProblem,
  urlProblem,
} from './source.js';
import { catalogOfSpecifier, patchedPackageName } from './specifier.js';

const ref = (name: string, raw: string) =>
  parseRef(name, raw, DEFAULT_PNPM_LOCK_LIMITS, 'here');

describe('parseRef', () => {
  it('puts the dependency name in front of a bare version, as pnpm does', () => {
    const parsed = ref('react', '18.2.0');
    expect(parsed).toMatchObject({ kind: 'dep', aliased: false });
    expect(parsed.kind === 'dep' && parsed.target.raw).toBe('react@18.2.0');
  });

  it('keeps the peers of a version with its key', () => {
    const parsed = ref('react-dom', '18.2.0(react@18.2.0)');
    expect(parsed.kind === 'dep' && parsed.target.raw).toBe(
      'react-dom@18.2.0(react@18.2.0)',
    );
    expect(parsed.kind === 'dep' && parsed.aliased).toBe(false);
  });

  it.each([
    ['string-width-cjs', 'string-width@4.2.3', 'string-width@4.2.3'],
    [
      'c-alias',
      '@scope/c@0.19.3(@emnapi/core@1.11.1)',
      '@scope/c@0.19.3(@emnapi/core@1.11.1)',
    ],
    [
      'x',
      'y@git+https://h/y.git#' + 'a'.repeat(40),
      'y@git+https://h/y.git#' + 'a'.repeat(40),
    ],
  ])('reads %s -> %s as another package (an alias)', (name, raw, key) => {
    const parsed = ref(name, raw);
    expect(parsed).toMatchObject({ kind: 'dep', aliased: true });
    expect(parsed.kind === 'dep' && parsed.target.raw).toBe(key);
  });

  it.each([
    ['a', 'file:../a'],
    ['a', 'https://codeload.github.com/o/r/tar.gz/' + 'b'.repeat(40)],
    ['a', 'git+ssh://git@github.com/o/r.git#' + 'c'.repeat(40)],
    ['node', 'runtime:22.0.0'],
  ])('does not take the @ of %s: %s for an alias', (name, raw) => {
    const parsed = ref(name, raw);
    expect(parsed).toMatchObject({ kind: 'dep', aliased: false });
    expect(parsed.kind === 'dep' && parsed.target.raw).toBe(`${name}@${raw}`);
  });

  it('reads a link as a directory and not a package', () => {
    expect(ref('lib', 'link:../packages/lib')).toEqual({
      kind: 'link',
      raw: 'link:../packages/lib',
      target: '../packages/lib',
    });
  });

  it.each([
    ['link:', 'unsafe-path'],
    ['link:/etc', 'unsafe-path'],
    ['link:C:\\x', 'unsafe-path'],
    ['link:..\\x', 'unsafe-path'],
    ['latest', 'dep-path'],
    ['^18.0.0', 'dep-path'],
    ['npm:react@18', 'dep-path'],
    ['workspace:*', 'dep-path'],
    ['', 'dep-path'],
  ])('refuses %j', (raw, reason) => {
    expect(() => ref('a', raw)).toThrow(PnpmLockError);
    try {
      ref('a', raw);
    } catch (error) {
      expect((error as PnpmLockError).reason).toBe(reason);
      expect((error as PnpmLockError).where).toBe('here');
    }
  });
});

describe('integrityProblem', () => {
  const digest = (bytes: number, fill = 0x61) =>
    Buffer.alloc(bytes, fill).toString('base64');

  it.each(['sha1', 'sha256', 'sha384', 'sha512'] as const)(
    'accepts a %s digest',
    (algorithm) => {
      const bytes = { sha1: 20, sha256: 32, sha384: 48, sha512: 64 }[algorithm];
      expect(integrityProblem(`${algorithm}-${digest(bytes)}`)).toBeUndefined();
    },
  );

  it.each([
    ['md5-' + digest(16), 'an algorithm the install does not prove with'],
    ['sha512', 'no digest'],
    ['sha512-', 'an empty digest'],
    ['sha512-' + digest(63), 'a digest one byte short'],
    ['sha512-' + digest(65), 'a digest one byte long'],
    ['sha1-' + digest(64), 'the wrong algorithm for the length'],
    ['sha512-' + digest(64).replace(/=+$/u, ''), 'padding left off'],
    ['sha512-' + digest(64) + '=', 'padding added'],
    ['sha512-' + digest(64).replace(/.$/u, '!'), 'a character outside base64'],
    ['sha512-' + digest(64) + '?foo=bar', 'ssri options'],
    ['sha512-' + digest(64) + ' sha1-' + digest(20), 'two tokens'],
    ['SHA512-' + digest(64), 'an upper case algorithm'],
    [' sha512-' + digest(64), 'leading space'],
    ['sha512-' + 'A'.repeat(86) + '=B', 'a stray padding character'],
  ])('refuses %j (%s)', (value) => {
    expect(integrityProblem(value)).toBeTypeOf('string');
  });

  it('refuses digests whose base64 is not canonical (trailing bits set)', () => {
    // 20 zero bytes encode to 27 characters and one "=": the last character may only be A, E, I, ...
    const good = Buffer.alloc(20).toString('base64');
    expect(integrityProblem(`sha1-${good}`)).toBeUndefined();
    const bad = good.slice(0, -2) + 'B=';
    expect(integrityProblem(`sha1-${bad}`)).toBeTypeOf('string');
  });
});

describe('paths and URLs', () => {
  it.each([
    ['../a', undefined],
    ['packages/a', undefined],
    ['.', undefined],
    ['', 'is empty'],
    ['/abs', 'absolute'],
    ['~/x', 'absolute'],
    ['C:/x', 'absolute'],
    ['a\\b', 'backslash'],
    ['a\u0000b', 'control'],
    ['a\nb', 'control'],
  ])('relativePathProblem(%j)', (path, word) => {
    const problem = relativePathProblem(path);
    if (word === undefined) expect(problem).toBeUndefined();
    else expect(problem).toContain(word);
  });

  it.each([
    ['packages/a', false, undefined],
    ['.', true, undefined],
    ['.', false, 'itself'],
    ['../a', true, 'leaves'],
    ['a/../b', true, 'leaves'],
    ['a//b', true, 'normalized'],
    ['a/./b', true, 'normalized'],
    ['a/', true, 'normalized'],
    ['/a', true, 'absolute'],
  ])('insidePathProblem(%j, allowDot=%s)', (path, allowDot, word) => {
    const problem = insidePathProblem(path, allowDot);
    if (word === undefined) expect(problem).toBeUndefined();
    else expect(problem).toContain(word);
  });

  it.each([
    ['https://registry.npmjs.org/a/-/a-1.0.0.tgz', undefined],
    ['http://localhost:4873/a.tgz', undefined],
    ['https://codeload.github.com/o/r/tar.gz/abc#path:sub', undefined],
    ['ftp://h/a.tgz', 'not an http'],
    ['https://u:p@h/a.tgz', 'password'],
    ['https://token@h/a.tgz', 'credentials'],
    ['https:///a.tgz', 'no host'],
    ['https://h/a b.tgz', 'whitespace'],
    ['', 'not an http'],
    // Read through the guard, so a host no DNS name can be is refused by length.
    [`https://${'a'.repeat(254)}/a.tgz`, 'longer than 253'],
  ])('tarballUrlProblem(%j)', (url, word) => {
    const problem = tarballUrlProblem(url);
    if (word === undefined) expect(problem).toBeUndefined();
    else expect(problem).toContain(word);
  });

  it.each([
    ['https://github.com/o/r.git', 'git', undefined],
    ['https://git@github.com:o/r.git', 'git', undefined],
    ['ssh://git@github.com/o/r.git', 'git', undefined],
    ['ssh://deploy@host/o/r.git', 'git', undefined],
    ['git@github.com:o/r.git', 'git', undefined],
    ['https://TOKEN@github.com/o/r.git', 'git', 'credentials'],
    ['ssh://git:secret@host/o/r.git', 'git', 'password'],
    ['deploy@host:o/r.git', 'git', 'other than'],
    ['github.com/o/r.git', 'git', 'not a URL'],
  ])('urlProblem(%j, %s)', (url, scheme, word) => {
    const problem = urlProblem(url, scheme as 'git');
    if (word === undefined) expect(problem).toBeUndefined();
    else expect(problem).toContain(word);
  });
});

describe('classifyVersion and semver', () => {
  it('knows registry versions from the other forms', () => {
    expect(classifyVersion('1.2.3')).toEqual({ kind: 'registry' });
    expect(classifyVersion('1.2.3-rc.1+b5')).toEqual({ kind: 'registry' });
    expect(classifyVersion('file:../a')).toEqual({ kind: 'file' });
    expect(classifyVersion('runtime:22.0.0')).toEqual({ kind: 'runtime' });
    expect(classifyVersion('https://h/a.tgz')).toEqual({ kind: 'tarball' });
    expect(classifyVersion('git+https://h/a.git#' + 'f'.repeat(64))).toEqual({
      kind: 'git',
    });
    expect(
      classifyVersion('git+https://h/a.git#' + 'f'.repeat(40) + '&path:x'),
    ).toEqual({
      kind: 'git',
    });
  });

  it.each([
    '1',
    '1.2',
    '01.2.3',
    '1.2.3.4',
    'v1.2.3',
    '1.2.3-',
    '1.2.3-01',
    '1.2.3+',
    '^1.2.3',
    ' 1.2.3',
  ])('is not semver: %j', (value) => {
    expect(isSemver(value)).toBe(false);
  });

  it('does not backtrack on a long near-miss', () => {
    const started = Date.now();
    expect(
      isSemver('1.0.0-' + '1'.repeat(5000) + '.' + '-'.repeat(5000) + '!'),
    ).toBe(false);
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe('specifiers', () => {
  it('recognises a catalog and the name of one', () => {
    expect(catalogOfSpecifier('catalog:')).toBe('default');
    expect(catalogOfSpecifier('catalog:react17')).toBe('react17');
    expect(catalogOfSpecifier('^1.0.0')).toBeUndefined();
  });

  it('names the package a patch key patches', () => {
    expect(patchedPackageName('braces')).toBe('braces');
    expect(patchedPackageName('braces@3.0.3')).toBe('braces');
    expect(patchedPackageName('@scope/pkg@^1.0.0')).toBe('@scope/pkg');
    expect(patchedPackageName('@scope/pkg')).toBe('@scope/pkg');
  });
});
