import { describe, expect, it } from 'vitest';
import { parseProject } from '@openpacker/packslip';
import {
  basePurl,
  formatPackslipPurl,
  parsePackslipPurl,
} from '../src/index.js';

describe('packslip PURLs', () => {
  it('reads the project from the namespace and name together', () => {
    expect(
      parsePackslipPurl('pkg:packslip/github.com/jdx/hk@2.5.0'),
    ).toMatchObject({
      project: { name: 'github.com/jdx/hk', forge: 'github' },
      version: '2.5.0',
    });
    expect(parsePackslipPurl('pkg:packslip/mise.jdx.dev').project.name).toBe(
      'mise.jdx.dev',
    );
    expect(
      parsePackslipPurl('pkg:packslip/github.com/oxc-project/oxc/oxlint@1.0.0')
        .project,
    ).toMatchObject({
      repository: 'oxc-project/oxc',
      subpath: 'oxlint',
    });
    expect(
      parsePackslipPurl('pkg:packslip/github.com/jdx/hk').version,
    ).toBeUndefined();
  });

  it('keeps a prerelease and build metadata exactly as signed', () => {
    const purl = formatPackslipPurl(
      parseProject('github.com/jdx/hk'),
      '2.0.0-rc.1+build.5',
    );
    expect(purl).toBe('pkg:packslip/github.com/jdx/hk@2.0.0-rc.1%2Bbuild.5');
    expect(parsePackslipPurl(purl).version).toBe('2.0.0-rc.1+build.5');
  });

  it('round-trips a variant qualifier', () => {
    const purl = formatPackslipPurl(
      parseProject('github.com/acme/tool'),
      '1.0.0',
      'fips',
    );
    expect(purl).toBe('pkg:packslip/github.com/acme/tool@1.0.0?variant=fips');
    expect(parsePackslipPurl(purl)).toMatchObject({
      variant: 'fips',
      version: '1.0.0',
    });
  });

  it('names a package’s history without its version, variant included', () => {
    expect(
      basePurl('pkg:packslip/github.com/acme/tool@1.2.3?variant=fips'),
    ).toBe('pkg:packslip/github.com/acme/tool?variant=fips');
    expect(basePurl('pkg:packslip/github.com/acme/tool@1.2.3')).toBe(
      'pkg:packslip/github.com/acme/tool',
    );
  });

  it.each([
    ['another type', 'pkg:npm/lodash@4.17.21'],
    ['not a PURL', 'github.com/jdx/hk'],
    ['a name that is not a project', 'pkg:packslip/hk'],
    ['an uppercase host', 'pkg:packslip/GitHub.com/jdx/hk'],
    ['an unknown qualifier', 'pkg:packslip/github.com/jdx/hk@1.0.0?arch=arm64'],
    [
      'a malformed variant',
      'pkg:packslip/github.com/jdx/hk@1.0.0?variant=Bad Value',
    ],
    ['a version that is not semver', 'pkg:packslip/github.com/jdx/hk@v1.0'],
    ['a subpath', 'pkg:packslip/github.com/jdx/hk@1.0.0#bin'],
    ['a one-segment GitHub project', 'pkg:packslip/github.com/jdx@1.0.0'],
  ])('refuses %s', (_why, purl) => {
    expect(() => parsePackslipPurl(purl)).toThrow(
      expect.objectContaining({ code: 'INVALID_PURL' }),
    );
  });
});
