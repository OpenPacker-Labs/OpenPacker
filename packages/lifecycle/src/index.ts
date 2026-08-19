import {
  canonicalDigest,
  compareCanonicalStrings,
} from '@openpacker/canonical';
import type {
  Digest,
  LifecycleEvent,
  LifecycleState,
  PackageIdentity,
} from '@openpacker/contracts';

type Action = LifecycleEvent['action'];
type Authority = LifecycleEvent['authority'];
export type LifecycleScope =
  | 'package'
  | 'exact-version'
  | 'release'
  | 'channel'
  | 'digest';

export interface LifecycleTarget {
  packagePurl: string;
  exactPurl?: string;
  release?: string;
  channel?: string;
  digest?: Digest;
}

export interface LifecycleAuthorityRule {
  authority: Authority;
  scopes: LifecycleScope[];
  actions: Action[];
}
export interface LifecycleHistoryEntry {
  event: LifecycleEvent;
  scope: LifecycleScope;
  accepted: boolean;
  reason?:
    | 'unauthorized'
    | 'not-effective'
    | 'expired'
    | 'subject-mismatch'
    | 'restore-without-denial';
}
export interface LifecycleReduction {
  state: LifecycleState;
  history: LifecycleHistoryEntry[];
  root: Digest;
}

const rank: Record<LifecycleScope, number> = {
  package: 0,
  'exact-version': 1,
  release: 2,
  channel: 3,
  digest: 4,
};
const denying = new Set<Action>([
  'yanked',
  'quarantined',
  'revoked',
  'delisted',
  'removed-from-channel',
]);

function time(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed))
    throw new TypeError(`Invalid ${label}: ${value}`);
  return parsed;
}

function sameDigest(left: Digest, right?: Digest): boolean {
  return right?.algorithm === left.algorithm && right.value === left.value;
}

function eventScope(event: LifecycleEvent): {
  scope: LifecycleScope;
  matches: (target: LifecycleTarget) => boolean;
} {
  if ('algorithm' in event.subject)
    return {
      scope: 'digest',
      matches: (target) => sameDigest(event.subject as Digest, target.digest),
    };
  const subject = event.subject as PackageIdentity;
  const release = subject.qualifiers.release;
  const channel = subject.qualifiers.channel;
  if (channel)
    return {
      scope: 'channel',
      matches: (target) =>
        target.channel === channel &&
        target.packagePurl === subject.canonicalPurl,
    };
  if (release)
    return {
      scope: 'release',
      matches: (target) =>
        target.release === release &&
        target.packagePurl === subject.canonicalPurl,
    };
  if (subject.exactPurl)
    return {
      scope: 'exact-version',
      matches: (target) => target.exactPurl === subject.exactPurl,
    };
  return {
    scope: 'package',
    matches: (target) => target.packagePurl === subject.canonicalPurl,
  };
}

function status(action: Action, previous: LifecycleState): LifecycleState {
  if (action === 'ownership-transferred') return previous;
  const eligible =
    action === 'published' ||
    action === 'promoted' ||
    action === 'restored' ||
    action === 'deprecated';
  return {
    status: action,
    eligible,
    warnings:
      action === 'deprecated'
        ? [
            {
              code: 'lifecycle.deprecated',
              message: 'Package release is deprecated',
            },
          ]
        : [],
  };
}

export async function reduceLifecycle(
  events: readonly LifecycleEvent[],
  target: LifecycleTarget,
  evaluationTime: string,
  authorityRules: readonly LifecycleAuthorityRule[],
  /** Authorities established by signature/provenance verification upstream. */
  verifiedAuthorities: ReadonlyMap<string, Authority>,
): Promise<LifecycleReduction> {
  const now = time(evaluationTime, 'evaluation time');
  const entries = events
    .map((event) => {
      const scoped = eventScope(event);
      return {
        event,
        scope: scoped.scope,
        matches: scoped.matches(target),
        effective: time(event.effectiveAt, 'effectiveAt'),
        issued: time(event.issuedAt, 'issuedAt'),
        expires: event.expiresAt
          ? time(event.expiresAt, 'expiresAt')
          : undefined,
      };
    })
    .sort(
      (left, right) =>
        left.effective - right.effective ||
        rank[left.scope] - rank[right.scope] ||
        left.issued - right.issued ||
        compareCanonicalStrings(left.event.eventId, right.event.eventId),
    );

  let state: LifecycleState = {
    status: 'unknown',
    eligible: false,
    warnings: [],
  };
  let lastDeny = -1;
  const derivation: string[] = [];
  const history: LifecycleHistoryEntry[] = [];
  for (const entry of entries) {
    let reason: LifecycleHistoryEntry['reason'];
    if (!entry.matches) reason = 'subject-mismatch';
    else if (entry.effective > now) reason = 'not-effective';
    else if (entry.expires !== undefined && entry.expires <= now)
      reason = 'expired';
    else if (
      !authorityRules.some(
        (rule) =>
          verifiedAuthorities.get(entry.event.eventId) === rule.authority &&
          entry.event.authority === rule.authority &&
          rule.scopes.includes(entry.scope) &&
          rule.actions.includes(entry.event.action),
      )
    )
      reason = 'unauthorized';
    else if (entry.event.action === 'restored' && lastDeny < 0)
      reason = 'restore-without-denial';
    history.push({
      event: entry.event,
      scope: entry.scope,
      accepted: reason === undefined,
      ...(reason ? { reason } : {}),
    });
    if (reason) continue;
    if (denying.has(entry.event.action)) lastDeny = entry.effective;
    if (entry.event.action === 'restored' && entry.effective <= lastDeny)
      continue;
    if (
      lastDeny >= 0 &&
      entry.effective > lastDeny &&
      entry.event.action !== 'restored' &&
      !denying.has(entry.event.action) &&
      entry.event.action !== 'ownership-transferred'
    )
      continue;
    state = status(entry.event.action, state);
    derivation.push(entry.event.eventId);
  }
  state = { ...state, derivationEventIds: derivation };
  const root = await canonicalDigest(
    history as unknown as import('@openpacker/contracts').JsonValue,
  );
  return { state, history, root };
}

export function defaultLifecycleAllowed(
  state: LifecycleState,
  options: { allowYanked?: boolean; allowDelistedExact?: boolean } = {},
): boolean {
  if (state.status === 'yanked') return options.allowYanked === true;
  if (state.status === 'delisted') return options.allowDelistedExact === true;
  return state.eligible;
}
