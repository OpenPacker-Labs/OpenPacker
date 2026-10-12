import { PackslipError } from './errors.js';
import type { Artifact } from './types.js';

/** The machine a consumer installs for. An unknown `libc` is left out. */
export interface HostPlatform {
  readonly os: string;
  readonly arch: string;
  readonly libc?: string;
}

/**
 * Fallbacks the specification permits but does not require. Each is reported
 * to the caller, and neither is tried while an exact match exists.
 */
export type SelectionFallback = 'musl-on-gnu' | 'rosetta';

export interface SelectionRequest {
  readonly host: HostPlatform;
  /** What the user asked for; absent selects only artifacts with no variant. */
  readonly variant?: string;
  /** Formats the consumer can unpack, best first. */
  readonly formats: readonly string[];
  readonly fallbacks?: readonly SelectionFallback[];
}

export interface Selected {
  readonly artifact: Artifact;
  readonly fallback?: SelectionFallback;
}

type Outcome =
  | { readonly kind: 'chosen'; readonly artifact: Artifact }
  | { readonly kind: 'none' }
  | { readonly kind: 'ambiguous'; readonly names: readonly string[] };

function fits(field: string | undefined, host: string | undefined): boolean {
  return field === undefined || field === host;
}

/** How many of os, arch, libc an artifact names: a host build beats a portable one. */
function specificity(artifact: Artifact): number {
  return [artifact.os, artifact.arch, artifact.libc].filter(
    (value) => value !== undefined,
  ).length;
}

function choose(
  artifacts: readonly Artifact[],
  host: HostPlatform,
  request: SelectionRequest,
): Outcome {
  const candidates = artifacts.filter((artifact) => {
    if (!fits(artifact.os, host.os) || !fits(artifact.arch, host.arch))
      return false;
    // A consumer that does not know its libc cannot take a libc-specific build.
    if (artifact.libc !== undefined && artifact.libc !== host.libc)
      return false;
    if ((artifact.variant ?? undefined) !== request.variant) return false;
    return request.formats.includes(artifact.format);
  });
  if (candidates.length === 0) return { kind: 'none' };
  const rank = (artifact: Artifact) => ({
    specificity: specificity(artifact),
    format: request.formats.indexOf(artifact.format),
  });
  const best = [...candidates].sort((left, right) => {
    const l = rank(left);
    const r = rank(right);
    return r.specificity - l.specificity || l.format - r.format;
  });
  const first = best[0];
  if (first === undefined) return { kind: 'none' };
  const top = rank(first);
  const tied = best.filter((artifact) => {
    const candidate = rank(artifact);
    return (
      candidate.specificity === top.specificity &&
      candidate.format === top.format
    );
  });
  // Two artifacts nothing can tell apart are a vendor error; guessing would
  // install a build the vendor never said was the right one.
  if (tied.length > 1)
    return { kind: 'ambiguous', names: tied.map((artifact) => artifact.name) };
  return { kind: 'chosen', artifact: first };
}

/**
 * Choose the one artifact that fits a host, per the specification's selection
 * rules: match the host, match the variant, keep only formats the consumer can
 * unpack, prefer the most specific build, then the consumer's format order, and
 * refuse an unresolved tie.
 */
export function selectArtifact(
  artifacts: readonly Artifact[],
  request: SelectionRequest,
): Selected {
  const exact = choose(artifacts, request.host, request);
  if (exact.kind === 'chosen') return { artifact: exact.artifact };
  if (exact.kind === 'ambiguous') throw ambiguous(exact.names);

  const attempts: { fallback: SelectionFallback; host: HostPlatform }[] = [];
  const allowed = request.fallbacks ?? [];
  if (
    allowed.includes('musl-on-gnu') &&
    request.host.os === 'linux' &&
    request.host.libc === 'gnu'
  )
    attempts.push({
      fallback: 'musl-on-gnu',
      host: { ...request.host, libc: 'musl' },
    });
  if (
    allowed.includes('rosetta') &&
    request.host.os === 'darwin' &&
    request.host.arch === 'aarch64'
  )
    attempts.push({
      fallback: 'rosetta',
      host: { ...request.host, arch: 'x86_64' },
    });
  for (const attempt of attempts) {
    const outcome = choose(artifacts, attempt.host, request);
    if (outcome.kind === 'chosen')
      return { artifact: outcome.artifact, fallback: attempt.fallback };
    if (outcome.kind === 'ambiguous') throw ambiguous(outcome.names);
  }
  throw new PackslipError(
    'NO_ARTIFACT',
    `No artifact fits ${request.host.os}/${request.host.arch}` +
      `${request.host.libc === undefined ? '' : `/${request.host.libc}`}` +
      `${request.variant === undefined ? '' : ` (variant ${request.variant})`}` +
      ` in a format opm can unpack (${request.formats.join(', ')})`,
  );
}

function ambiguous(names: readonly string[]): PackslipError {
  return new PackslipError(
    'AMBIGUOUS_ARTIFACT',
    `Artifacts ${names.join(', ')} fit equally; the vendor must scope or name them differently`,
  );
}
