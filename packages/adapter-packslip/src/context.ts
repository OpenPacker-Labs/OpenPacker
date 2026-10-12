import type { JsonValue } from '@openpacker/contracts';
import type {
  Clock,
  HostLookup,
  HttpTransport,
} from '@openpacker/adapter-core';
import {
  detectHost,
  type DetectedHost,
  type GithubEndpoints,
  type JsonObject,
} from '@openpacker/packslip';
import { createNetwork } from './network.js';
import {
  asProviderError,
  PackslipProvider,
  ResolutionCache,
} from './provider.js';
import { basePurl } from './purl.js';
import { decodeRecord, type PriorAttestation } from './record.js';
import { decodeSettings } from './settings.js';

/** The part of the host's adapter context a packslip provider reads. */
export interface PackslipContext {
  readonly transport?: HttpTransport;
  readonly fetch?: typeof fetch;
  readonly now?: () => string;
  readonly settings?: JsonObject;
  readonly priorAttestations?: JsonObject;
}

/**
 * What the process says outside the project. The host reads the environment
 * and hands the values over; this package never touches `process.env`, so a
 * provider's behaviour is always a function of what it was given.
 */
export interface PackslipEnvironment {
  /** The text of a Sigstore `trusted_root.json` the operator supplies. */
  readonly trustedRoot?: string;
  /** The name of the environment variable that holds a GitHub token. */
  readonly githubTokenEnv?: string;
  readonly endpoints?: GithubEndpoints;
  readonly host?: DetectedHost;
  /** A DNS seam for tests; production resolves names itself. */
  readonly lookup?: HostLookup;
}

const SHARED = {};
const caches = new WeakMap<object, ResolutionCache>();
let detected: DetectedHost | undefined;

function cacheFor(context: PackslipContext): ResolutionCache {
  // A transport or fetch of its own means a different world (a test, a
  // mirror); resolutions must not leak between worlds.
  const key = context.transport ?? context.fetch ?? SHARED;
  const existing = caches.get(key);
  if (existing !== undefined) return existing;
  const created = new ResolutionCache();
  caches.set(key, created);
  return created;
}

function priorFrom(
  raw: JsonObject | undefined,
): Record<string, PriorAttestation> {
  const prior: Record<string, PriorAttestation> = {};
  // Keyed by the canonical versionless PURL however the host spelled it: a key
  // that did not match what the provider looks up would read as "no history",
  // which is the one answer that must never come from a spelling difference.
  for (const [purl, value] of Object.entries(raw ?? {}))
    prior[basePurl(purl)] = decodeRecord(value);
  return prior;
}

export function providerForContext(
  context: PackslipContext,
  environment: PackslipEnvironment = {},
): PackslipProvider {
  detected ??= detectHost();
  const clock: Clock = { now: context.now ?? (() => new Date().toISOString()) };
  // Bad configuration is the operator's to fix: report it under a code opm
  // knows how to show, before any request is made.
  try {
    return new PackslipProvider({
      clock,
      fetcher: createNetwork({
        ...(context.transport !== undefined && {
          transport: context.transport,
        }),
        ...(context.fetch !== undefined && { fetch: context.fetch }),
        ...(environment.lookup !== undefined && { lookup: environment.lookup }),
        ...(environment.githubTokenEnv !== undefined && {
          githubTokenEnv: environment.githubTokenEnv,
        }),
      }),
      settings: decodeSettings(context.settings),
      prior: priorFrom(context.priorAttestations),
      host: environment.host ?? detected,
      ...(environment.trustedRoot !== undefined && {
        trustedRoot: environment.trustedRoot,
      }),
      ...(environment.endpoints !== undefined && {
        endpoints: environment.endpoints,
      }),
      cache: cacheFor(context),
    });
  } catch (error) {
    throw asProviderError(
      error instanceof Error ? error : new Error(String(error)),
    );
  }
}

export type { JsonValue };
