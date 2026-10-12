import { PackslipError } from './errors.js';

/**
 * The semantic-versioning 2.0.0 grammar, exactly as semver.org publishes it.
 * packslip refuses every other spelling: a `v` prefix, a missing patch, or a
 * leading zero belongs to the tag, never to the signed version.
 */
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/u;

export function isSemver(text: string): boolean {
  return SEMVER.test(text);
}

export function assertSemver(text: string, what = 'version'): void {
  if (!SEMVER.test(text))
    throw new PackslipError(
      'INVALID_STATEMENT',
      `${what} "${text}" is not a semantic version (MAJOR.MINOR.PATCH)`,
    );
}

interface Parsed {
  readonly core: readonly [bigint, bigint, bigint];
  readonly prerelease: readonly string[];
}

function parse(version: string): Parsed {
  const match = SEMVER.exec(version);
  if (match === null)
    throw new PackslipError(
      'INVALID_INPUT',
      `"${version}" is not a semantic version (MAJOR.MINOR.PATCH)`,
    );
  return {
    core: [BigInt(match[1] ?? 0), BigInt(match[2] ?? 0), BigInt(match[3] ?? 0)],
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  };
}

function compareIdentifiers(left: string, right: string): number {
  const leftNumeric = /^\d+$/u.test(left);
  const rightNumeric = /^\d+$/u.test(right);
  if (leftNumeric && rightNumeric) {
    const difference = BigInt(left) - BigInt(right);
    return difference < 0n ? -1 : difference > 0n ? 1 : 0;
  }
  // A numeric identifier always ranks below an alphanumeric one.
  if (leftNumeric) return -1;
  if (rightNumeric) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Semver 2.0.0 precedence. Build metadata is ignored, so a backport `20.19.1`
 * still ranks below `22.0.0` whatever order the vendor published them in, and
 * a prerelease ranks below the release it precedes.
 *
 * The comparison is written out here rather than taken from a library: the
 * `semver` package is CommonJS-only and this package ships dual builds. It is
 * kept as a test oracle, which cross-checks this against random versions.
 */
export function compareVersions(left: string, right: string): number {
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    const x = a.core[index] ?? 0n;
    const y = b.core[index] ?? 0n;
    if (x !== y) return x < y ? -1 : 1;
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0)
    return a.prerelease.length === b.prerelease.length
      ? 0
      : a.prerelease.length === 0
        ? 1
        : -1;
  const shared = Math.min(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < shared; index += 1) {
    const order = compareIdentifiers(
      a.prerelease[index] ?? '',
      b.prerelease[index] ?? '',
    );
    if (order !== 0) return order;
  }
  return a.prerelease.length === b.prerelease.length
    ? 0
    : a.prerelease.length < b.prerelease.length
      ? -1
      : 1;
}

export function isPrerelease(version: string): boolean {
  return SEMVER.exec(version)?.[4] !== undefined;
}

/**
 * The channel a prerelease is on: its first prerelease identifier, when that
 * identifier is not numeric. `1.2.0-1` has no channel; `1.3.0-nightly.1` is on
 * `nightly`. The format stores no channel field because one could contradict
 * the signed version.
 */
export function channelOf(version: string): string | undefined {
  const prerelease = SEMVER.exec(version)?.[4];
  if (prerelease === undefined) return undefined;
  const first = prerelease.split('.')[0] ?? '';
  return /^\d+$/u.test(first) ? undefined : first;
}

function withoutBuild(version: string): string {
  const plus = version.indexOf('+');
  return plus === -1 ? version : version.slice(0, plus);
}

/**
 * A version request names a prefix of the dot-separated components: `20`
 * matches every `20.x.y`, `3.12` every `3.12.x`, and `1.2.0-beta` the betas of
 * `1.2.0`. An exact version matches itself, with or without build metadata.
 */
export function matchesVersionPrefix(
  version: string,
  request: string,
): boolean {
  if (request === '') return false;
  if (version === request) return true;
  const want = withoutBuild(request).split('.');
  const have = withoutBuild(version).split('.');
  // A prerelease part carries a dot of its own: 1.2.0-beta.2 has components
  // 1, 2, 0-beta, 2. Matching by components keeps `1.2` from matching `1.20`.
  if (want.length > have.length) return false;
  return want.every((component, index) => component === have[index]);
}

/**
 * Whether `request` names this release by its vendor tag (`v2026.9.1`,
 * `oxlint_v1.0.0`), with or without a leading `v`.
 */
export function matchesTag(tag: string | undefined, request: string): boolean {
  if (tag === undefined || request === '') return false;
  if (tag === request) return true;
  const bare = (value: string) =>
    value.startsWith('v') ? value.slice(1) : value;
  return bare(tag) === bare(request);
}

export interface VersionRequest {
  /** `latest`, a version prefix, an exact version, or the vendor's tag. */
  readonly spec: string;
  readonly prerelease: boolean;
  /** Restrict to one prerelease channel (`beta`, `nightly`). */
  readonly channel?: string;
}

/**
 * Whether a candidate satisfies everything a request asks of it.
 *
 * A prerelease is never reached by accident: `latest` and bare prefixes skip
 * it. It is eligible only when the request is explicit — the prerelease flag,
 * a channel, a spec that spells out the prerelease part, or the vendor's tag.
 */
export function satisfiesRequest(
  candidate: { readonly version: string; readonly tag?: string },
  request: VersionRequest,
): boolean {
  const { version, tag } = candidate;
  const wantsLatest = request.spec === 'latest' || request.spec === '';
  const byPrefix = !wantsLatest && matchesVersionPrefix(version, request.spec);
  const byTag = !wantsLatest && matchesTag(tag, request.spec);
  if (request.channel !== undefined && channelOf(version) !== request.channel)
    return false;
  if (isPrerelease(version)) {
    const explicit =
      request.prerelease ||
      request.channel !== undefined ||
      byTag ||
      (byPrefix && request.spec.includes('-'));
    if (!explicit) return false;
  }
  return wantsLatest || byPrefix || byTag;
}
