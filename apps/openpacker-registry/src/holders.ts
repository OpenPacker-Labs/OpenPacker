/**
 * Who holds a namespace, what that costs them, and how a name moves.
 *
 * A namespace proof binds a *key* to a name prefix. That is the wrong unit for
 * two questions this registry has to answer. A survey of the MCP registry found
 * a single domain behind 75 namespaces, 62 of which served a marketing page
 * rather than a server — a pattern nobody could see because ownership was only
 * ever recorded per proof. And a publish limit charged per namespace is not a
 * limit at all, because registering another namespace is precisely the cheap
 * move being limited.
 *
 * So proofs are attributed to a **holder**: the DNS name, the GitHub org, or
 * the operator's decision that the proof actually rests on. Ownership becomes a
 * query, and a quota has something real to be charged against.
 */

import { canonicalDigest, formatDigest } from '@openpacker/canonical';
import type { Digest, JsonValue } from '@openpacker/contracts';

export type ProofMethod =
  | 'dns-txt'
  | 'https-well-known'
  | 'registry-configured';

/**
 * Derive the holder a proof really rests on.
 *
 * `com.example.tools` proved by DNS rests on `example.com` — the same party as
 * `com.example.cli`, however many namespaces they take out. `io.github.acme`
 * rests on the GitHub org, not on the whole of github.io, or one org could
 * speak for every other. An operator decision is named as such: the holder is
 * the registry, and pretending otherwise would launder a configuration choice
 * into a proof.
 */
export function holderOf(namespace: string, method: ProofMethod): string {
  const segments = namespace.split('.');
  if (method === 'registry-configured') return `operator:${namespace}`;

  // A forge namespace's authority stops at the account, not at the forge.
  const FORGES: Readonly<Record<string, string>> = {
    'io.github': 'github',
    'com.github': 'github',
  };
  const prefix = segments.slice(0, 2).join('.');
  const forge = FORGES[prefix];
  if (forge !== undefined && segments.length >= 3)
    return `${forge}:${segments[2]}`;

  // Otherwise the proof is over a DNS name, which is the reverse of the first
  // two labels: `com.example.anything` is proved by whoever holds example.com.
  const domain = segments.slice(0, 2).reverse().join('.');
  return `dns:${domain}`;
}

export interface QuotaPolicy {
  /** Publishes allowed per holder per window. */
  limit: number;
  windowSeconds: number;
}

export interface QuotaState {
  limit: number;
  windowSeconds: number;
  remaining: number;
  resetAt?: string;
}

/**
 * Whether one more publish fits, given the times of recent ones.
 *
 * A sliding window rather than fixed buckets: a fixed bucket lets a publisher
 * spend the whole allowance at :59 and the whole next allowance at :00, which
 * is twice the limit at the moment it matters most.
 */
export function quotaState(
  recent: readonly number[],
  policy: QuotaPolicy,
  now: number,
): QuotaState {
  const cutoff = now - policy.windowSeconds * 1000;
  const inWindow = recent.filter((at) => at > cutoff);
  const remaining = Math.max(0, policy.limit - inWindow.length);
  if (remaining > 0)
    return {
      limit: policy.limit,
      windowSeconds: policy.windowSeconds,
      remaining,
    };

  // The window frees up when the oldest publish in it ages out, so that is the
  // only honest Retry-After. Telling a client to come back at the top of the
  // window would be wrong by up to a full window.
  const oldest = Math.min(...inWindow);
  return {
    limit: policy.limit,
    windowSeconds: policy.windowSeconds,
    remaining: 0,
    resetAt: new Date(oldest + policy.windowSeconds * 1000).toISOString(),
  };
}

/** Seconds until a quota frees up, for `Retry-After`. Never below one. */
export function retryAfterSeconds(state: QuotaState, now: number): number {
  if (state.resetAt === undefined) return 1;
  const reset = Date.parse(state.resetAt);
  if (!Number.isFinite(reset)) return state.windowSeconds;
  return Math.max(1, Math.ceil((reset - now) / 1000));
}

export interface PackageRedirect {
  redirectVersion: '1';
  from: string;
  to: string;
  effectiveAt: string;
  reason: 'rename' | 'transfer';
  previousHolder?: string;
  nextHolder?: string;
}

/** Canonical digest of a redirect, for signing and verifying. */
export async function redirectDigest(
  redirect: PackageRedirect,
): Promise<Digest> {
  return canonicalDigest(redirect as unknown as JsonValue);
}

/** The bytes a redirect must be signed over — the same construction as everything else here. */
export async function redirectMessage(
  redirect: PackageRedirect,
): Promise<Uint8Array> {
  return new TextEncoder().encode(formatDigest(await redirectDigest(redirect)));
}

/**
 * Follow a redirect chain to the name that currently resolves.
 *
 * Bounded and cycle-guarded. A publisher who renames twice should still be
 * resolvable, but a chain that loops — or one long enough to be a denial of
 * service — is refused rather than followed, and the caller is told which.
 */
export function resolveRedirect(
  name: string,
  redirects: ReadonlyMap<string, PackageRedirect>,
  maximumHops = 8,
): { name: string; hops: readonly PackageRedirect[] } | { cycle: true } {
  const hops: PackageRedirect[] = [];
  const seen = new Set<string>([name]);
  let current = name;
  for (let hop = 0; hop < maximumHops; hop += 1) {
    const next = redirects.get(current);
    if (!next) return { name: current, hops };
    if (seen.has(next.to)) return { cycle: true };
    seen.add(next.to);
    hops.push(next);
    current = next.to;
  }
  return { cycle: true };
}
