/**
 * Does what a manifest advertises still work?
 *
 * The MCP registry was measured at 11.2% of advertised endpoints not speaking
 * MCP at the URL given — roughly 1,177 URLs where a client follows the registry
 * and connects to something else. Not dead hosts: live hosts serving a
 * marketing page where the server used to be. A registry entry is a claim, and
 * nobody re-checked it.
 *
 * Checks are driven by requests rather than a schedule. A sweep spends the same
 * egress on every package regardless of whether anyone wants it; requests are a
 * better sampler, because the packages people resolve are exactly the ones
 * whose rot matters, and the long tail costs nothing until someone asks.
 *
 * Two classifications are easy to get wrong and both were observed in that
 * survey:
 *
 * - **Gated is healthy.** 26.5% of endpoints answered 401/402/403 because they
 *   are commercial services wanting a token. Treating non-200 as failure
 *   condemns a quarter of a registry. The surveyor's own false positive was a
 *   402 Payment Required — enumerating the auth statuses from memory rather
 *   than from the spec cost them a wrong answer, so all three are listed here.
 * - **A timeout is not evidence.** A 5xx or a hang from wherever the registry
 *   happens to sit says something about the network between them, not about
 *   the package. Recording it as failure exports the registry's weather as a
 *   fact about someone else's software.
 */

import type { HttpTransport } from '@openpacker/adapter-core';
import type { Digest } from '@openpacker/contracts';

export type ServiceabilityState =
  | 'verified'
  | 'gated'
  | 'unreachable'
  | 'unchecked';

export interface ServiceabilityRecord {
  state: ServiceabilityState;
  checkedAt: string;
  method: 'digest-match' | 'head' | 'status' | 'none';
  /** Why, when the state is not `verified`. Free text, for a human. */
  detail?: string;
}

/** Statuses that mean "running, wants credentials this registry does not have". */
const GATED = new Set([401, 402, 403, 407]);

export interface CheckInput {
  locations: readonly string[];
  digest?: Digest;
  size?: number;
  transport: HttpTransport;
  now: () => string;
  signal?: AbortSignal;
}

/**
 * Check one distribution's locations, first answer wins.
 *
 * Only the first location that says anything definite is used: a package
 * mirrored to three places is reachable if any of them answers, and probing all
 * three to agree costs three times as much for no extra certainty.
 */
export async function checkServiceability(
  input: CheckInput,
): Promise<ServiceabilityRecord> {
  if (input.locations.length === 0)
    return {
      state: 'unchecked',
      checkedAt: input.now(),
      method: 'none',
      detail: 'The manifest advertises no location to check',
    };

  let lastIndeterminate: ServiceabilityRecord | undefined;
  for (const location of input.locations) {
    const result = await checkOne(location, input);
    if (result.state === 'verified' || result.state === 'gated') return result;
    if (result.state === 'unreachable') return result;
    lastIndeterminate = result;
  }
  return (
    lastIndeterminate ?? {
      state: 'unchecked',
      checkedAt: input.now(),
      method: 'none',
    }
  );
}

async function checkOne(
  location: string,
  input: CheckInput,
): Promise<ServiceabilityRecord> {
  const checkedAt = input.now();
  let response;
  try {
    response = await input.transport.request({
      url: location,
      method: 'HEAD',
      headers: { accept: '*/*' },
      ...(input.signal && { signal: input.signal }),
    });
  } catch (error) {
    // A refused connection or a DNS failure from here is still only evidence
    // about here. It is recorded as indeterminate, not as the package's fault.
    return {
      state: 'unchecked',
      checkedAt,
      method: 'none',
      detail: `Could not reach ${location}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  if (GATED.has(response.status))
    return {
      state: 'gated',
      checkedAt,
      method: 'status',
      detail: `${location} answered ${response.status}; it is running and wants credentials`,
    };

  // 5xx is the origin having a bad day. A registry that writes that down as
  // "unreachable" turns a transient outage into a durable mark.
  if (response.status >= 500)
    return {
      state: 'unchecked',
      checkedAt,
      method: 'none',
      detail: `${location} answered ${response.status}`,
    };

  if (response.status === 404 || response.status === 410)
    return {
      state: 'unreachable',
      checkedAt,
      method: 'status',
      detail: `${location} answered ${response.status}: nothing is served there`,
    };

  if (response.status >= 400)
    return {
      state: 'unreachable',
      checkedAt,
      method: 'status',
      detail: `${location} answered ${response.status}`,
    };

  // A 200 proves something is there. It does not prove it is the right bytes —
  // which is the exact failure the MCP survey found, a live host serving a page
  // where the artifact used to be. Compare the length when the origin states
  // one, and say plainly which check actually happened.
  const declared = contentLength(response.headers);
  if (
    input.size !== undefined &&
    declared !== undefined &&
    declared !== input.size
  )
    return {
      state: 'unreachable',
      checkedAt,
      method: 'head',
      detail: `${location} serves ${declared} bytes; the manifest says ${input.size}`,
    };

  return {
    state: 'verified',
    checkedAt,
    method: declared === undefined ? 'status' : 'head',
    ...(input.digest === undefined && {
      detail:
        'Reachable. The manifest states no digest, so the bytes were not identified',
    }),
  };
}

function contentLength(
  headers: Readonly<Record<string, string | undefined>>,
): number | undefined {
  const raw = headers['content-length'] ?? headers['Content-Length'];
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

/** Whether a record is old enough that the next reader should trigger a check. */
export function isStale(
  record: ServiceabilityRecord | undefined,
  ttlMilliseconds: number,
  now: number,
): boolean {
  if (!record) return true;
  const checked = Date.parse(record.checkedAt);
  if (!Number.isFinite(checked)) return true;
  return now - checked >= ttlMilliseconds;
}
