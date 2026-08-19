/**
 * Read any PREX registry over its HTTP binding.
 *
 * The client is deliberately dumb about which endpoints exist: it reads the
 * registry's own Registry Definition and refuses operations the registry does
 * not advertise. That is what makes "any conforming registry" real rather than
 * a promise — a registry that serves only metadata and a registry that also
 * serves bytes are both usable, and the client can tell which it is talking to
 * without probing.
 *
 * See `spec/prex/v1/registry-api.md`.
 */

import { canonicalDigest, formatDigest } from '@openpacker/canonical';
import { validateContract } from '@openpacker/conformance';
import type {
  Digest,
  JsonValue,
  PackageManifest,
  PackagePage,
  RegistryEntry,
  SignedRevocationList,
  VersionList,
} from '@openpacker/contracts';
import {
  BoundedFetchTransport,
  ProviderError,
  type HttpTransport,
} from '@openpacker/adapter-core';
import { Ed25519Verifier } from '@openpacker/trust';

/** The Registry Definition shape, as this client needs it. */
export interface RegistryDefinitionLike {
  registryDefinitionVersion: string;
  registryId: string;
  displayName?: string;
  purlTypes: readonly string[];
  resources: readonly {
    '@id': string;
    '@type': string | readonly string[];
  }[];
}

export const WELL_KNOWN = '/.well-known/prex-registry';
const SIGNED_REVOCATION_LIST_SCHEMA =
  'https://openpacker.dev/spec/prex/v1/schemas/registry-api.schema.json#/$defs/SignedRevocationList';

export interface RegistryClientOptions {
  /** Registry base URL. Trailing slash optional. */
  baseUrl: string;
  transport?: HttpTransport;
  fetch?: typeof fetch;
  /**
   * Public keys this client will accept registry or publisher signatures from,
   * keyed by key id. Absent means signatures are read but not checked — which
   * `verifyEntry` reports rather than silently treating as verified.
   */
  keys?: Readonly<Record<string, JsonWebKey>>;
  /**
   * How long a fetched revocation list is reused. A client that cached one
   * forever would never learn about a revocation, so this is a TTL rather than
   * a one-shot.
   */
  revocationTtlMilliseconds?: number;
  /** Injectable clock, so TTL behaviour is testable without waiting. */
  clock?: () => number;
  /** Caller may tighten, never raise, the mandatory untrusted-pagination limits. */
  paginationLimits?: Partial<PaginationLimits>;
}

export interface PaginationLimits {
  maximumPages: number;
  maximumEntries: number;
  maximumBytes: number;
  maximumCursorLength: number;
  maximumElapsedMilliseconds: number;
}

const PAGINATION_LIMITS: PaginationLimits = {
  maximumPages: 100,
  maximumEntries: 100_000,
  maximumBytes: 64 * 1024 * 1024,
  maximumCursorLength: 4096,
  maximumElapsedMilliseconds: 30_000,
};

export interface ListOptions {
  search?: string;
  purlType?: string;
  updatedSince?: string;
  limit?: number;
  cursor?: string;
  signal?: AbortSignal;
}

export class RegistryClient {
  readonly #baseUrl: string;
  readonly #transport: HttpTransport;
  readonly #keys: Readonly<Record<string, JsonWebKey>>;
  #definition: RegistryDefinitionLike | undefined;
  #revocations: { entries: RevocationEntryLike[]; known: boolean } | undefined;
  #revocationsFetchedAt = 0;
  #revocationSerial = 0;
  readonly #revocationTtl: number;
  readonly #clock: () => number;
  readonly #paginationLimits: PaginationLimits;

  constructor(options: RegistryClientOptions) {
    const url = new URL(options.baseUrl);
    if (
      url.protocol !== 'https:' &&
      url.hostname !== 'localhost' &&
      !isLoopback(url)
    )
      throw new ProviderError(
        'INVALID_PROVIDER_ENDPOINT',
        `A registry must be https, or loopback for development: ${options.baseUrl}`,
      );
    this.#baseUrl = url.origin + url.pathname.replace(/\/$/u, '');
    this.#transport =
      options.transport ??
      new BoundedFetchTransport({
        // Only this registry's own origin. A registry that redirects a metadata
        // read somewhere else is not something to follow blindly.
        allowedOrigins: [url.origin],
        ...(options.fetch ? { fetch: options.fetch } : {}),
      });
    this.#keys = options.keys ?? {};
    // Caching a revocation list forever means a long-lived client never learns
    // about a revocation — which is the entire thing revocation is for. Five
    // minutes by default; a caller running a long process can shorten it.
    this.#revocationTtl = options.revocationTtlMilliseconds ?? 300_000;
    this.#clock = options.clock ?? (() => Date.now());
    this.#paginationLimits = paginationLimits(options.paginationLimits);
  }

  /**
   * The registry's revocation list, fetched once and reused.
   *
   * A registry that does not serve one yields an empty list rather than an
   * error: not every registry does revocation, and a client that refused to
   * talk to those would be unable to read most of them. What it must not do is
   * treat "no list" as "nothing is revoked" *silently* — `revocationsKnown`
   * reports which it was.
   */
  async revocations(
    signal?: AbortSignal,
  ): Promise<{ entries: RevocationEntryLike[]; known: boolean }> {
    if (
      this.#revocations &&
      this.#clock() - this.#revocationsFetchedAt < this.#revocationTtl
    )
      return this.#revocations;
    if (!(await this.supports('prex.registry.key-lifecycle/1', signal))) {
      this.#revocations = { entries: [], known: false };
      this.#revocationsFetchedAt = this.#clock();
      return this.#revocations;
    }
    const value = await this.#json(`${this.#baseUrl}/v1/revocations`, signal);
    const validation = validateContract(SIGNED_REVOCATION_LIST_SCHEMA, value);
    if (!validation.valid)
      throw new ProviderError(
        'INVALID_RESPONSE',
        `Registry served an invalid SignedRevocationList: ${validation.errors[0]?.message ?? 'schema validation failed'}`,
      );
    const body = value as unknown as SignedRevocationList;
    const definition = await this.definition(signal);
    if (body.list.registryId !== definition.registryId)
      throw new ProviderError(
        'INVALID_SIGNATURE',
        `Revocation list belongs to ${body.list.registryId}, not ${definition.registryId}`,
      );
    const digest = await canonicalDigest(body.list as unknown as JsonValue);
    if (
      body.listDigest.algorithm !== digest.algorithm ||
      body.listDigest.value !== digest.value
    )
      throw new ProviderError(
        'DIGEST_MISMATCH',
        `Revocation list states ${formatDigest(body.listDigest)} but hashes to ${formatDigest(digest)}`,
      );
    const message = new TextEncoder().encode(formatDigest(digest));
    let signatureVerified = false;
    for (const signature of body.signatures) {
      if (signature.role !== 'registry') continue;
      const key = this.#keys[signature.keyId];
      if (!key) continue;
      const verifier = await Ed25519Verifier.fromJwk(signature.keyId, key);
      if (await verifier.verify(message, signature.signature)) {
        signatureVerified = true;
        break;
      }
    }
    if (!signatureVerified)
      throw new ProviderError(
        'INVALID_SIGNATURE',
        'Revocation list has no valid signature from a configured registry key',
      );
    const now = this.#clock();
    const issuedAt = Date.parse(body.list.issuedAt);
    const expiresAt = body.list.expiresAt
      ? Date.parse(body.list.expiresAt)
      : issuedAt + this.#revocationTtl;
    if (issuedAt > now + 300_000 || expiresAt <= now || expiresAt < issuedAt)
      throw new ProviderError(
        'STALE_METADATA',
        'Registry revocation list is not currently fresh',
      );
    const serial = body.list.serial;
    // A replayed older list would pin a client to the state of the world from
    // before a compromise, which is the attack a serial exists to stop.
    if (serial < this.#revocationSerial)
      throw new ProviderError(
        'STALE_METADATA',
        `Registry served revocation serial ${serial} after ${this.#revocationSerial}; refusing to go backwards.`,
      );
    this.#revocationSerial = serial;
    this.#revocations = { entries: body.list.revoked, known: true };
    this.#revocationsFetchedAt = now;
    return this.#revocations;
  }

  /** The registry's service index, fetched once and reused. */
  async definition(signal?: AbortSignal): Promise<RegistryDefinitionLike> {
    if (this.#definition) return this.#definition;
    const body = await this.#json(`${this.#baseUrl}${WELL_KNOWN}`, signal);
    const definition = body as unknown as RegistryDefinitionLike;
    if (definition.registryDefinitionVersion !== '1')
      throw new ProviderError(
        'UNSUPPORTED_PROVIDER',
        `Registry at ${this.#baseUrl} speaks registryDefinitionVersion ` +
          `${String(definition.registryDefinitionVersion)}, not 1`,
      );
    if (
      !Array.isArray(definition.resources) ||
      definition.resources.length === 0
    )
      throw new ProviderError(
        'INVALID_PROVIDER_RESPONSE',
        'A Registry Definition must advertise at least one resource',
      );
    this.#definition = definition;
    return definition;
  }

  /** Whether the registry advertises a resource type. */
  async supports(type: string, signal?: AbortSignal): Promise<boolean> {
    const definition = await this.definition(signal);
    return definition.resources.some((resource) =>
      (Array.isArray(resource['@type'])
        ? resource['@type']
        : [resource['@type']]
      ).includes(type),
    );
  }

  async #require(type: string, what: string, signal?: AbortSignal) {
    if (!(await this.supports(type, signal)))
      throw new ProviderError(
        'PROVIDER_CAPABILITY_MISSING',
        `Registry ${(await this.definition(signal)).registryId} does not advertise ` +
          `${type}, so it cannot ${what}.`,
      );
  }

  /** One page of packages. Prefer `listAll` unless you are paging yourself. */
  async list(options: ListOptions = {}): Promise<PackagePage> {
    return (await this.#listPage(options)).page;
  }

  async #listPage(
    options: ListOptions = {},
  ): Promise<{ page: PackagePage; bytes: number }> {
    await this.#require(
      options.updatedSince === undefined
        ? 'prex.registry.search/1'
        : 'prex.registry.sync/1',
      options.updatedSince === undefined ? 'be searched' : 'be synced from',
      options.signal,
    );
    const url = new URL(`${this.#baseUrl}/v1/packages`);
    for (const [key, value] of [
      ['search', options.search],
      ['purlType', options.purlType],
      ['updatedSince', options.updatedSince],
      ['limit', options.limit?.toString()],
      ['cursor', options.cursor],
    ] as const)
      if (value !== undefined && value !== '') url.searchParams.set(key, value);
    const response = await this.#jsonDocument(url.toString(), options.signal);
    const page = response.value as unknown as PackagePage;
    if (!Array.isArray(page.packages) || !page.metadata)
      throw new ProviderError(
        'INVALID_PROVIDER_RESPONSE',
        'Registry package page has no packages array or metadata',
      );
    return { page, bytes: response.bytes };
  }

  /**
   * Every package matching the query, following cursors.
   *
   * An empty page is not the end of the walk while a cursor is present — a
   * federating registry may return one while a slow source is still answering,
   * and stopping there would silently truncate a mirror.
   */
  async *listAll(options: ListOptions = {}): AsyncGenerator<RegistryEntry> {
    const limits = this.#paginationLimits;
    const deadline = AbortSignal.timeout(limits.maximumElapsedMilliseconds);
    const signal = options.signal
      ? AbortSignal.any([options.signal, deadline])
      : deadline;
    let cursor = options.cursor;
    const seen = new Set<string>();
    let pages = 0;
    let entries = 0;
    let bytes = 0;
    for (;;) {
      if (pages >= limits.maximumPages)
        throw paginationLimit(`more than ${limits.maximumPages} pages`);
      let result: { page: PackagePage; bytes: number };
      try {
        result = await this.#listPage({
          ...options,
          signal,
          ...(cursor === undefined ? {} : { cursor }),
        });
      } catch (error) {
        if (deadline.aborted && !options.signal?.aborted)
          throw paginationLimit(
            `longer than ${limits.maximumElapsedMilliseconds} milliseconds`,
          );
        throw error;
      }
      pages += 1;
      entries += result.page.packages.length;
      bytes += result.bytes;
      if (entries > limits.maximumEntries)
        throw paginationLimit(`more than ${limits.maximumEntries} entries`);
      if (bytes > limits.maximumBytes)
        throw paginationLimit(`more than ${limits.maximumBytes} bytes`);
      const page = result.page;
      for (const entry of page.packages) yield entry;
      const next = page.metadata.nextCursor;
      if (next === undefined || next === null) return;
      if (typeof next !== 'string' || next.length > limits.maximumCursorLength)
        throw paginationLimit(
          `a cursor longer than ${limits.maximumCursorLength} characters`,
        );
      // A registry that returns the cursor it was given would loop forever.
      if (seen.has(next))
        throw new ProviderError(
          'INVALID_PROVIDER_RESPONSE',
          `Registry repeated pagination cursor ${next}; refusing to loop.`,
        );
      seen.add(next);
      cursor = next;
    }
  }

  async versions(name: string, signal?: AbortSignal): Promise<VersionList> {
    await this.#require(
      'prex.registry.enumerate-versions/1',
      'list versions',
      signal,
    );
    return (await this.#json(
      `${this.#baseUrl}/v1/packages/${encodePathSegment(name)}/versions`,
      signal,
    )) as VersionList;
  }

  /** One entry. `version` accepts the literal `latest`. */
  async entry(
    name: string,
    version: string,
    signal?: AbortSignal,
  ): Promise<RegistryEntry> {
    await this.#require(
      'prex.registry.package-manifest/1',
      'serve package manifests',
      signal,
    );
    return (await this.#json(
      `${this.#baseUrl}/v1/packages/${encodePathSegment(name)}/versions/${encodePathSegment(version)}`,
      signal,
    )) as RegistryEntry;
  }

  /**
   * Check an entry against what it claims about itself.
   *
   * Returns what was actually checked rather than a boolean, because "the
   * digest matched but nothing was signed" and "a registry signature verified"
   * are different states and a caller's policy may care which.
   */
  async verifyEntry(entry: RegistryEntry): Promise<EntryVerification> {
    const digest = await canonicalDigest(
      entry.manifest as unknown as JsonValue,
    );
    const stated = entry.registryMetadata.manifestDigest;
    const digestMatches =
      stated === undefined
        ? undefined
        : stated.algorithm === digest.algorithm &&
          stated.value === digest.value;
    if (digestMatches === false)
      throw new ProviderError(
        'DIGEST_MISMATCH',
        `Registry entry for ${entry.manifest.name}@${entry.manifest.version} states ` +
          `${formatDigest(stated!)} but its manifest hashes to ${formatDigest(digest)}`,
      );

    const { entries: revocations } = await this.revocations();
    const message = new TextEncoder().encode(formatDigest(digest));
    const verified: {
      keyId: string;
      role?: 'publisher' | 'registry';
      status: 'valid' | 'invalid' | 'unknown-key' | 'revoked';
    }[] = [];
    for (const signature of entry.signatures ?? []) {
      const jwk = this.#keys[signature.keyId];
      if (!jwk) {
        verified.push({
          keyId: signature.keyId,
          ...(signature.role === undefined ? {} : { role: signature.role }),
          status: 'unknown-key',
        });
        continue;
      }
      const verifier = await Ed25519Verifier.fromJwk(signature.keyId, jwk);
      const holds = await verifier.verify(message, signature.signature);
      // "This signature is forged" and "this signature was good and the key has
      // since been withdrawn" are different facts about a package, and a
      // consumer's policy may accept one and not the other.
      const status = !holds
        ? 'invalid'
        : revoked(
              signature.keyId,
              entry.registryMetadata.publishedAt,
              revocations,
            )
          ? 'revoked'
          : 'valid';
      verified.push({
        keyId: signature.keyId,
        ...(signature.role === undefined ? {} : { role: signature.role }),
        status,
      });
    }
    // An invalid signature is worse than an absent one: something signed this
    // and the signature does not hold.
    const bad = verified.find((item) => item.status === 'invalid');
    if (bad)
      throw new ProviderError(
        'INVALID_SIGNATURE',
        `Signature from ${bad.keyId} on ${entry.manifest.name}@${entry.manifest.version} does not verify`,
      );

    return {
      digest,
      digestMatches: digestMatches ?? false,
      signatures: verified,
    };
  }

  async #json(url: string, signal?: AbortSignal): Promise<JsonValue> {
    return (await this.#jsonDocument(url, signal)).value;
  }

  async #jsonDocument(
    url: string,
    signal?: AbortSignal,
  ): Promise<{ value: JsonValue; bytes: number }> {
    const response = await this.#transport.request({
      url,
      method: 'GET',
      headers: { accept: 'application/json' },
      ...(signal ? { signal } : {}),
    });
    if (response.status === 404)
      throw new ProviderError('PACKAGE_NOT_FOUND', `Not found: ${url}`);
    if (response.status >= 400)
      throw new ProviderError(
        'UPSTREAM_UNAVAILABLE',
        `Registry returned ${response.status} for ${url}`,
      );
    try {
      return {
        value: JSON.parse(new TextDecoder().decode(response.body)) as JsonValue,
        bytes: response.body.byteLength,
      };
    } catch (error) {
      throw new ProviderError(
        'INVALID_PROVIDER_RESPONSE',
        `Registry returned a body that is not JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

function paginationLimits(
  requested: Partial<PaginationLimits> | undefined,
): PaginationLimits {
  return Object.fromEntries(
    Object.entries(PAGINATION_LIMITS).map(([name, ceiling]) => {
      const value = requested?.[name as keyof PaginationLimits] ?? ceiling;
      if (!Number.isSafeInteger(value) || value < 1 || value > ceiling)
        throw new RangeError(
          `${name} must be an integer between 1 and ${ceiling}`,
        );
      return [name, value];
    }),
  ) as unknown as PaginationLimits;
}

function paginationLimit(detail: string): ProviderError {
  return new ProviderError(
    'INVALID_PROVIDER_RESPONSE',
    `Registry pagination returned ${detail}; refusing an unbounded walk.`,
  );
}

export interface RevocationEntryLike {
  keyId: string;
  revokedAt: string;
  effective: 'from-now' | 'retroactive';
  reason?: string;
}

export interface EntryVerification {
  digest: Digest;
  /** False when the entry stated no digest to check against. */
  digestMatches: boolean;
  signatures: readonly {
    keyId: string;
    role?: 'publisher' | 'registry';
    status: 'valid' | 'invalid' | 'unknown-key' | 'revoked';
  }[];
}

export type { PackageManifest, PackagePage, RegistryEntry, VersionList };

/**
 * Percent-encode a path segment without encoding the `/` inside a scoped npm
 * name away — registries route on the whole name, so `@scope/pkg` stays one
 * segment pair rather than becoming `%2F`.
 */
function encodePathSegment(value: string): string {
  return value
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
}

function isLoopback(url: URL): boolean {
  const host = url.hostname.replace(/^\[|\]$/gu, '');
  if (host === '::1') return true;
  const octets = /^(\d{1,3})\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.exec(host);
  return octets !== null && Number(octets[1]) === 127;
}

export { prexRegistryModule, PrexRegistryProvider } from './adapter.js';

/**
 * Whether a revocation applies to a signature made at `signedAt`.
 *
 * `retroactive` disowns everything the key ever signed; `from-now` keeps what
 * it signed before the revocation. A routine rotation that invalidated every
 * past signature would break every lockfile pinning something that key signed,
 * which is why the two are distinguished rather than collapsed.
 */
function revoked(
  keyId: string,
  signedAt: string | undefined,
  revocations: readonly RevocationEntryLike[],
): boolean {
  const entry = revocations.find((candidate) => candidate.keyId === keyId);
  if (!entry) return false;
  if (entry.effective === 'retroactive') return true;
  if (signedAt === undefined) return true;
  const signed = Date.parse(signedAt);
  const at = Date.parse(entry.revokedAt);
  if (!Number.isFinite(signed) || !Number.isFinite(at)) return true;
  return signed >= at;
}
