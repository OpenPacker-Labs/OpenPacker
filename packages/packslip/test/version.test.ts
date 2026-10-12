import fc from 'fast-check';
import semver from 'semver';
import { describe, expect, it } from 'vitest';
import {
  PackslipError,
  assertSemver,
  channelOf,
  compareVersions,
  isPrerelease,
  isSemver,
  matchesTag,
  matchesVersionPrefix,
  satisfiesRequest,
} from '../src/index.js';

describe('semantic versions', () => {
  it.each([
    '0.0.0',
    '1.2.3',
    '2026.9.1',
    '1.0.0-rc.1',
    '1.0.0-alpha.beta',
    '1.0.0+build.5',
    '1.0.0-0.3.7+x',
  ])('accepts %s', (version) => expect(isSemver(version)).toBe(true));

  it.each([
    'v1.2.3',
    '1.2',
    '1',
    '01.2.3',
    '1.02.3',
    '1.2.03',
    '1.2.3.4',
    '1.2.3-',
    '1.2.3-01',
    '1.2.3+',
    ' 1.2.3',
    '1.2.3 ',
    '',
    '1.2.3-rc..1',
  ])(
    'refuses %j: the spelling belongs to the tag, not the signed version',
    (version) => {
      expect(isSemver(version)).toBe(false);
      expect(() => assertSemver(version)).toThrow(PackslipError);
    },
  );

  it('orders by precedence, not by publication order', () => {
    const versions = [
      '22.0.0',
      '20.19.1',
      '20.9.0',
      '1.10.0',
      '1.9.0',
      '2.0.0-rc.1',
      '2.0.0',
    ];
    expect([...versions].sort(compareVersions)).toEqual([
      '1.9.0',
      '1.10.0',
      '2.0.0-rc.1',
      '2.0.0',
      '20.9.0',
      '20.19.1',
      '22.0.0',
    ]);
  });

  it('ranks a prerelease below its release and numeric identifiers below alphanumeric ones', () => {
    expect(compareVersions('1.0.0-alpha', '1.0.0')).toBe(-1);
    expect(compareVersions('1.0.0-alpha.1', '1.0.0-alpha.beta')).toBe(-1);
    expect(compareVersions('1.0.0-alpha', '1.0.0-alpha.1')).toBe(-1);
    expect(compareVersions('1.0.0-2', '1.0.0-10')).toBe(-1);
  });

  it('ignores build metadata when ordering', () => {
    expect(compareVersions('1.0.0+a', '1.0.0+b')).toBe(0);
  });

  it('compares numbers beyond 2^53 exactly', () => {
    expect(
      compareVersions('1.0.9007199254740993', '1.0.9007199254740992'),
    ).toBe(1);
  });

  it('refuses to compare a spelling that is not a version', () => {
    expect(() => compareVersions('v1', '1.0.0')).toThrow(PackslipError);
  });

  describe('against the semver package as an independent oracle', () => {
    const part = fc.nat({ max: 30 });
    const identifier = fc.oneof(
      fc.nat({ max: 12 }).map(String),
      fc.constantFrom('alpha', 'beta', 'rc', 'x-y', 'a1', '0a'),
    );
    const version = fc
      .tuple(part, part, part, fc.array(identifier, { maxLength: 3 }))
      .map(
        ([major, minor, patch, pre]) =>
          `${major}.${minor}.${patch}${pre.length > 0 ? `-${pre.join('.')}` : ''}`,
      );

    it('agrees on validity and on order for random versions', () => {
      fc.assert(
        fc.property(version, version, (left, right) => {
          fc.pre(semver.valid(left) !== null && semver.valid(right) !== null);
          expect(isSemver(left)).toBe(true);
          expect(compareVersions(left, right)).toBe(
            semver.compare(left, right),
          );
        }),
        { numRuns: 2000 },
      );
    });

    it('agrees on whether random text is a strict semantic version', () => {
      fc.assert(
        fc.property(
          fc.stringMatching(
            /^[v=]?[0-9]{1,3}(\.[0-9]{1,3}){0,3}(-[0-9a-z.]{0,6})?(\+[0-9a-z.]{0,6})?$/u,
          ),
          (text) => {
            // `semver` is lenient about a leading v, "=", and padding, and drops
            // build metadata when it normalises. Strict means the text is already
            // exactly its own canonical form.
            const parsed = semver.parse(text);
            const strict =
              parsed !== null &&
              `${parsed.version}${parsed.build.length > 0 ? `+${parsed.build.join('.')}` : ''}` ===
                text;
            expect(isSemver(text)).toBe(strict);
          },
        ),
        { numRuns: 2000 },
      );
    });
  });
});

describe('prereleases and channels', () => {
  it('derives the channel from the first non-numeric prerelease identifier', () => {
    expect(channelOf('1.3.0-nightly.20260904')).toBe('nightly');
    expect(channelOf('1.2.0-beta.2')).toBe('beta');
    expect(channelOf('1.2.0-rc.1')).toBe('rc');
    expect(channelOf('1.2.0-1')).toBeUndefined();
    expect(channelOf('1.2.0')).toBeUndefined();
    expect(isPrerelease('1.2.0-1')).toBe(true);
    expect(isPrerelease('1.2.0+build')).toBe(false);
  });
});

describe('matching a request', () => {
  it('matches a prefix of dot-separated components, not of characters', () => {
    expect(matchesVersionPrefix('20.1.0', '20')).toBe(true);
    expect(matchesVersionPrefix('200.1.0', '20')).toBe(false);
    expect(matchesVersionPrefix('3.12.4', '3.12')).toBe(true);
    expect(matchesVersionPrefix('3.120.4', '3.12')).toBe(false);
    expect(matchesVersionPrefix('1.2.0-beta.2', '1.2.0-beta')).toBe(true);
    expect(matchesVersionPrefix('1.2.0', '1.2.0-beta')).toBe(false);
    expect(matchesVersionPrefix('1.2.3', '1.2.3.4')).toBe(false);
    expect(matchesVersionPrefix('1.2.3+build', '1.2.3')).toBe(true);
    expect(matchesVersionPrefix('1.2.3', '')).toBe(false);
  });

  it('matches the vendor’s tag with or without its leading v', () => {
    expect(matchesTag('v2026.9.1', 'v2026.9.1')).toBe(true);
    expect(matchesTag('v2026.9.1', '2026.9.1')).toBe(true);
    expect(matchesTag('2026.9.1', 'v2026.9.1')).toBe(true);
    expect(matchesTag('oxlint_v1.0.0', 'oxlint_v1.0.0')).toBe(true);
    expect(matchesTag(undefined, 'v1')).toBe(false);
    expect(matchesTag('v1.0.0', '')).toBe(false);
  });

  describe('eligibility', () => {
    const plain = { prerelease: false };
    it('skips prereleases for latest and bare prefixes', () => {
      expect(
        satisfiesRequest(
          { version: '1.2.0-rc.1' },
          { spec: 'latest', ...plain },
        ),
      ).toBe(false);
      expect(
        satisfiesRequest({ version: '1.2.0-rc.1' }, { spec: '1.2', ...plain }),
      ).toBe(false);
      expect(
        satisfiesRequest({ version: '1.2.0' }, { spec: '1.2', ...plain }),
      ).toBe(true);
    });

    it('reaches a prerelease only by an explicit request', () => {
      expect(
        satisfiesRequest(
          { version: '1.2.0-rc.1' },
          { spec: 'latest', prerelease: true },
        ),
      ).toBe(true);
      expect(
        satisfiesRequest(
          { version: '1.2.0-rc.1' },
          { spec: 'latest', prerelease: false, channel: 'rc' },
        ),
      ).toBe(true);
      expect(
        satisfiesRequest(
          { version: '1.2.0-rc.1' },
          { spec: '1.2.0-rc', ...plain },
        ),
      ).toBe(true);
      expect(
        satisfiesRequest(
          { version: '1.2.0-rc.1' },
          { spec: '1.2.0-rc.1', ...plain },
        ),
      ).toBe(true);
      expect(
        satisfiesRequest(
          { version: '1.2.0-rc.1', tag: 'v1.2.0-rc.1' },
          { spec: 'v1.2.0-rc.1', ...plain },
        ),
      ).toBe(true);
    });

    it('restricts a channel request to that channel', () => {
      const channel = { spec: 'latest', prerelease: false, channel: 'beta' };
      expect(satisfiesRequest({ version: '1.2.0-beta.2' }, channel)).toBe(true);
      expect(satisfiesRequest({ version: '1.2.0-rc.1' }, channel)).toBe(false);
      expect(satisfiesRequest({ version: '1.2.0' }, channel)).toBe(false);
    });

    it('matches by the vendor tag as well as by version', () => {
      expect(
        satisfiesRequest(
          { version: '2026.9.1', tag: 'jq-2026.9.1' },
          { spec: 'jq-2026.9.1', ...plain },
        ),
      ).toBe(true);
      expect(
        satisfiesRequest(
          { version: '2026.9.1', tag: 'jq-2026.9.1' },
          { spec: 'jq-2026.9.2', ...plain },
        ),
      ).toBe(false);
    });
  });
});
