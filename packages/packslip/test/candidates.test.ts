import { describe, expect, it } from 'vitest';
import {
  chooseRecommendation,
  rankCandidates,
  type Candidate,
  type VersionRequest,
} from '../src/index.js';

const candidate = (
  version: string,
  over: Partial<Candidate> = {},
): Candidate => ({
  version,
  tag: `v${version}`,
  bundleUrl: `https://example.test/${version}`,
  yanked: false,
  security: false,
  ...over,
});

const latest: VersionRequest = { spec: 'latest', prerelease: false };
const versions = (ordered: readonly Candidate[]) =>
  ordered.map((entry) => entry.version);

describe('ranking releases', () => {
  const pool = [
    candidate('1.9.0'),
    candidate('1.10.0'),
    candidate('2.0.0-rc.1'),
    candidate('20.19.1'),
    candidate('22.0.0'),
    candidate('2.0.0'),
  ];

  it('orders by semver precedence whatever order discovery returned', () => {
    expect(versions(rankCandidates(pool, latest).ordered)).toEqual([
      '22.0.0',
      '20.19.1',
      '2.0.0',
      '1.10.0',
      '1.9.0',
    ]);
    expect(
      versions(rankCandidates([...pool].reverse(), latest).ordered),
    ).toEqual(versions(rankCandidates(pool, latest).ordered));
  });

  it('keeps a late backport below a newer major', () => {
    const published = [candidate('22.0.0'), candidate('20.19.1')];
    expect(versions(rankCandidates(published, latest).ordered)[0]).toBe(
      '22.0.0',
    );
  });

  it('never offers a withdrawn release', () => {
    const ranked = rankCandidates(
      [
        candidate('2.0.0', { yanked: true, yankReason: 'CVE-2026-1' }),
        candidate('1.0.0'),
      ],
      latest,
    );
    expect(versions(ranked.ordered)).toEqual(['1.0.0']);
  });

  it('skips prereleases unless asked, then orders them by precedence', () => {
    expect(
      versions(
        rankCandidates(pool, { spec: 'latest', prerelease: true }).ordered,
      ).slice(0, 3),
    ).toEqual(['22.0.0', '20.19.1', '2.0.0']);
    expect(
      versions(
        rankCandidates(pool, {
          spec: 'latest',
          prerelease: false,
          channel: 'rc',
        }).ordered,
      ),
    ).toEqual(['2.0.0-rc.1']);
  });

  it('narrows to a version prefix and to the vendor’s own tag', () => {
    expect(
      versions(rankCandidates(pool, { spec: '1', prerelease: false }).ordered),
    ).toEqual(['1.10.0', '1.9.0']);
    expect(
      versions(
        rankCandidates(pool, { spec: 'v20.19.1', prerelease: false }).ordered,
      ),
    ).toEqual(['20.19.1']);
    expect(
      rankCandidates(pool, { spec: '9', prerelease: false }).ordered,
    ).toEqual([]);
  });
});

describe('the vendor’s recommendation', () => {
  const pool = [candidate('3.0.0'), candidate('2.8.4'), candidate('2.8.3')];

  it('comes first for an unconstrained request, without excluding newer releases', () => {
    const ranked = rankCandidates(pool, latest, {
      version: '2.8.4',
      source: 'signed-list',
    });
    expect(versions(ranked.ordered)).toEqual(['2.8.4', '3.0.0', '2.8.3']);
    expect(ranked.skipped).toBeUndefined();
  });

  it('does not change the order of an exact, prefix or channel request', () => {
    const recommendation = { version: '2.8.4', source: 'signed-list' as const };
    expect(
      versions(
        rankCandidates(pool, { spec: '2', prerelease: false }, recommendation)
          .ordered,
      ),
    ).toEqual(['2.8.4', '2.8.3']);
    expect(
      versions(
        rankCandidates(pool, { spec: '3', prerelease: false }, recommendation)
          .ordered,
      ),
    ).toEqual(['3.0.0']);
  });

  it('falls back to precedence when the recommendation was withdrawn, and says why', () => {
    const withdrawn = [
      candidate('3.0.0'),
      candidate('2.8.4', { yanked: true, yankReason: 'bad build' }),
    ];
    const ranked = rankCandidates(withdrawn, latest, {
      version: '2.8.4',
      source: 'signed-list',
    });
    expect(versions(ranked.ordered)).toEqual(['3.0.0']);
    expect(ranked.skipped?.reason).toContain('withdrawn');
    expect(ranked.skipped?.reason).toContain('bad build');
  });

  it('falls back when the recommendation is not among the discovered releases', () => {
    const ranked = rankCandidates(pool, latest, {
      version: '9.9.9',
      source: 'github-latest',
    });
    expect(versions(ranked.ordered)[0]).toBe('3.0.0');
    expect(ranked.skipped?.reason).toContain('not among');
  });

  it('falls back when the recommendation is a prerelease nobody asked for', () => {
    const withPre = [candidate('1.0.0'), candidate('2.0.0-rc.1')];
    const ranked = rankCandidates(withPre, latest, {
      version: '2.0.0-rc.1',
      source: 'signed-list',
    });
    expect(versions(ranked.ordered)).toEqual(['1.0.0']);
    expect(ranked.skipped?.reason).toContain('prerelease');
  });

  it('prefers the signed pointer and never swaps in GitHub’s when the signed one is ineligible', () => {
    expect(chooseRecommendation('1.0.0', '2.0.0')).toEqual({
      version: '1.0.0',
      source: 'signed-list',
    });
    expect(chooseRecommendation(undefined, '2.0.0')).toEqual({
      version: '2.0.0',
      source: 'github-latest',
    });
    expect(chooseRecommendation(undefined, undefined)).toBeUndefined();
  });
});
