import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { compareVersions, isSemver } from '@openpacker/packslip';
import { PackslipCodec, mediaTypeOf, packslipIdentity } from '../src/index.js';

const codec = new PackslipCodec();

describe('the packslip codec', () => {
  it('canonicalizes a PURL and refuses what is not one', () => {
    expect(codec.canonicalizePurl('pkg:packslip/github.com/jdx/hk@2.5.0')).toBe(
      'pkg:packslip/github.com/jdx/hk@2.5.0',
    );
    expect(
      codec.canonicalizePurl(
        'pkg:packslip/github.com/acme/tool@1.0.0?variant=fips',
      ),
    ).toBe('pkg:packslip/github.com/acme/tool@1.0.0?variant=fips');
    expect(() =>
      codec.canonicalizePurl('pkg:packslip/github.com/jdx/hk@v2'),
    ).toThrow();
    expect(() => codec.canonicalizePurl('pkg:npm/left-pad@1.0.0')).toThrow();
  });

  it('reads a native coordinate: a project and an optional version', () => {
    expect(
      codec.parseNativeCoordinate('github.com/jdx/hk@2.5.0'),
    ).toMatchObject({
      ecosystem: 'packslip',
      name: 'github.com/jdx/hk',
      version: '2.5.0',
    });
    expect(codec.parseNativeCoordinate('mise.jdx.dev').version).toBeUndefined();
    for (const bad of [
      '',
      'hk',
      'https://github.com/jdx/hk',
      'github.com/jdx/hk@v1',
    ])
      expect(() => codec.parseNativeCoordinate(bad)).toThrow(
        expect.objectContaining({ code: 'INVALID_NATIVE_COORDINATE' }),
      );
  });

  it('accepts only strict semantic versions, where the generic parser would be lenient', () => {
    expect(codec.parseNativeVersion('2026.9.1').normalized).toBe('2026.9.1');
    for (const lenient of ['v1.2.3', '1.2', '1', ' 1.2.3', '1.2.3.4'])
      expect(() => codec.parseNativeVersion(lenient)).toThrow(
        expect.objectContaining({ code: 'INVALID_NATIVE_VERSION' }),
      );
  });

  it('orders versions as packslip’s own comparison does (cross-checked on random versions)', () => {
    const part = fc.nat({ max: 40 });
    const version = fc
      .tuple(
        part,
        part,
        part,
        fc.option(fc.constantFrom('alpha', 'beta.1', 'rc.2', '3', 'x-y'), {
          nil: undefined,
        }),
      )
      .map(
        ([a, b, c, pre]) =>
          `${a}.${b}.${c}${pre === undefined ? '' : `-${pre}`}`,
      );
    fc.assert(
      fc.property(version, version, (left, right) => {
        expect(isSemver(left)).toBe(true);
        expect(Math.sign(codec.compareNativeVersions(left, right))).toBe(
          compareVersions(left, right),
        );
      }),
      { numRuns: 1000 },
    );
  });

  describe('version requests', () => {
    it.each([
      ['1.2', '1.2.0', true],
      ['1.2', '1.2.9', true],
      ['1.2', '1.20.0', false],
      ['1.2', '1.3.0', false],
      ['20', '20.19.1', true],
      ['20', '200.0.0', false],
      ['1.2.3', '1.2.3', true],
      ['1.2.3', '1.2.4', false],
      ['^1.2.3', '1.9.0', true],
      ['^1.2.3', '2.0.0', false],
      ['~1.2.3', '1.2.9', true],
      ['~1.2.3', '1.3.0', false],
      ['>=1.0.0 <2.0.0', '1.5.0', true],
      ['>=1.0.0 <2.0.0', '2.0.0', false],
      ['1.0.0 - 2.0.0', '1.5.0', true],
      ['*', '9.9.9', true],
    ])('%s is satisfied by %s: %s', (range, version, expected) => {
      expect(codec.satisfies(version, range)).toBe(expected);
    });

    it('keeps prereleases out of an ordinary range, as semver ranges do', () => {
      expect(codec.satisfies('1.3.0-rc.1', '^1.2.0')).toBe(false);
      expect(codec.satisfies('1.2.5-rc.1', '1.2.5-rc.1')).toBe(true);
    });

    it('turns a range into a version constraint', () => {
      expect(codec.toVers('^1.2.3')).toBeDefined();
    });
  });

  it('refuses to import a native lockfile, because there is none', () => {
    expect(() =>
      codec.translateLockResult(undefined as never, {} as never),
    ).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_OPERATION' }));
  });

  it('maps archive formats to media types opm recognises', () => {
    expect(mediaTypeOf('tar.gz')).toBe('application/gzip');
    expect(mediaTypeOf('tgz')).toBe('application/gzip');
    expect(mediaTypeOf('zip')).toBe('application/zip');
    expect(mediaTypeOf('tar')).toBe('application/x-tar');
    expect(mediaTypeOf('7z')).toBe('application/octet-stream');
  });

  it('describes a package identity with its namespace, qualifiers, and source', () => {
    const identity = packslipIdentity(
      'pkg:packslip/github.com/acme/tool@1.0.0?variant=fips',
      'https://github.com',
    );
    expect(identity).toMatchObject({
      purlType: 'packslip',
      name: 'tool',
      namespace: 'github.com/acme',
      qualifiers: { variant: 'fips' },
      version: '1.0.0',
      exactPurl: 'pkg:packslip/github.com/acme/tool@1.0.0?variant=fips',
      canonicalPurl: 'pkg:packslip/github.com/acme/tool?variant=fips',
    });
  });
});
