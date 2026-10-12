import {
  compareVersions,
  satisfiesRequest,
  type VersionRequest,
} from './version.js';

/**
 * A release a consumer could install, as discovery describes it. Discovery is
 * a hint until the bundle behind it verifies: the version here came from a tag
 * or an unverified list entry, and the signed statement must agree with it.
 */
export interface Candidate {
  readonly version: string;
  /** The vendor's tag, as the vendor spells it. */
  readonly tag?: string;
  /** Where the release's bundle is fetched from. */
  readonly bundleUrl: string;
  /** SHA-256 of the bundle, hex, when an accepted signed list pins it. */
  readonly bundleSha256?: string;
  readonly yanked: boolean;
  readonly yankReason?: string;
  readonly security: boolean;
}

export type RecommendationSource = 'signed-list' | 'github-latest';

export interface Recommendation {
  readonly version: string;
  readonly source: RecommendationSource;
}

export interface SkippedRecommendation {
  readonly recommendation: Recommendation;
  readonly reason: string;
}

export interface Ranking {
  /** Eligible candidates, best first. Walk them in order; stop at the first that verifies. */
  readonly ordered: readonly Candidate[];
  readonly skipped?: SkippedRecommendation;
}

/**
 * The vendor's recommendation for an unconstrained request: its signed list's
 * `latest` first, and GitHub's unsigned latest-release pointer only when the
 * list gives none. An ineligible signed pointer falls straight back to semver
 * order — it never hands over to GitHub's pointer instead.
 */
export function chooseRecommendation(
  signedLatest: string | undefined,
  githubLatest: string | undefined,
): Recommendation | undefined {
  if (signedLatest !== undefined)
    return { version: signedLatest, source: 'signed-list' };
  if (githubLatest !== undefined)
    return { version: githubLatest, source: 'github-latest' };
  return undefined;
}

/**
 * Order the candidates a request admits.
 *
 * Eligible means not withdrawn, satisfying the prerelease policy and channel,
 * and matching the request. Order is semver precedence — never the endpoint's
 * order or the list's — except that an unconstrained `latest` request puts the
 * vendor's recommendation first when it is itself eligible. A recommendation
 * recommends; it never excludes a newer release.
 */
export function rankCandidates(
  candidates: readonly Candidate[],
  request: VersionRequest,
  recommendation?: Recommendation,
): Ranking {
  const eligible = candidates
    .filter((candidate) => !candidate.yanked)
    .filter((candidate) =>
      satisfiesRequest(
        candidate.tag === undefined
          ? { version: candidate.version }
          : { version: candidate.version, tag: candidate.tag },
        request,
      ),
    )
    .sort(
      (left, right) =>
        compareVersions(right.version, left.version) ||
        (left.version < right.version
          ? 1
          : left.version > right.version
            ? -1
            : 0),
    );
  const unconstrained =
    (request.spec === 'latest' || request.spec === '') &&
    request.channel === undefined;
  if (!unconstrained || recommendation === undefined)
    return { ordered: eligible };
  const recommended = eligible.find(
    (candidate) => candidate.version === recommendation.version,
  );
  if (recommended !== undefined)
    return {
      ordered: [
        recommended,
        ...eligible.filter((candidate) => candidate !== recommended),
      ],
    };
  const known = candidates.find(
    (candidate) => candidate.version === recommendation.version,
  );
  const reason =
    known === undefined
      ? 'it is not among the discovered releases'
      : known.yanked
        ? `it was withdrawn${known.yankReason === undefined ? '' : ` (${known.yankReason})`}`
        : 'it does not satisfy the prerelease policy';
  return { ordered: eligible, skipped: { recommendation, reason } };
}
