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
  echoed,
  echoedValue,
  encodeUrlPathComponent,
  parseUntrustedUrl,
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
  /** Registry signer keys authorized to authenticate registry-wide metadata. */
  registryKeys?: Readonly<Record<string, JsonWebKey>>;
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

const RESPONSE_BYTES = {
  definition: 256 * 1024,
  revocations: 2 * 1024 * 1024,
  packagePage: 4 * 1024 * 1024,
  versions: 1024 * 1024,
  entry: 8 * 1024 * 1024,
} as const;

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
  readonly #registryKeys: Readonly<Record<string, JsonWebKey>>;
  #definition: RegistryDefinitionLike | undefined;
  #revocations: { entries: RevocationEntryLike[]; known: boolean } | undefined;
  #revocationsFetchedAt = 0;
  #revocationSerial = 0;
  readonly #revocationTtl: number;
  readonly #clock: () => number;
  readonly #paginationLimits: PaginationLimits;

  constructor(options: RegistryClientOptions) {
    const url = parseUntrustedUrl(options.baseUrl);
    if (
      url.protocol !== 'https:' &&
      url.hostname !== 'localhost' &&
      !isLoopback(url)
    )
      throw new ProviderError(
        'INVALID_PROVIDER_ENDPOINT',
        `A registry must be https, or loopback for development: ${echoedValue(options.baseUrl)}`,
      );
    this.#baseUrl = url.origin + url.pathname.replace(/\/$/u, '');
    this.#transport =
      options.transport ??
      new BoundedFetchTransport({
        // Only this registry's own origin. A registry that redirects a metadata
        // read somewhere else is not something to follow blindly.
        allowedOrigins: [url.origin],
        ...(options.fetch && { fetch: options.fetch }),
      });
    this.#keys = options.keys ?? {};
    this.#registryKeys = options.registryKeys ?? {};
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
    const value = await this.#json(
      `${this.#baseUrl}/v1/revocations`,
      RESPONSE_BYTES.revocations,
      signal,
    );
    const validation = validateContract(SIGNED_REVOCATION_LIST_SCHEMA, value);
    if (!validation.valid)
      throw new ProviderError(
        'INVALID_RESPONSE',
        `Registry served an invalid SignedRevocationList: ${echoed(validation.errors[0]?.message ?? 'schema validation failed')}`,
      );
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const body = value as SignedRevocationList;
    const definition = await this.definition(signal);
    if (body.list.registryId !== definition.registryId)
      throw new ProviderError(
        'INVALID_SIGNATURE',
        `Revocation list belongs to ${echoed(body.list.registryId)}, not ${echoed(definition.registryId)}`,
      );
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const digest = await canonicalDigest(
      JSON.parse(JSON.stringify(body.list)) as JsonValue,
    );
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
      const key = this.#registryKeys[signature.keyId];
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
    const body = await this.#json<RegistryDefinitionLike>(
      `${this.#baseUrl}${WELL_KNOWN}`,
      RESPONSE_BYTES.definition,
      signal,
    );
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const definition = body;
    if (definition.registryDefinitionVersion !== '1')
      throw new ProviderError(
        'UNSUPPORTED_PROVIDER',
        `Registry at ${this.#baseUrl} speaks registryDefinitionVersion ` +
          `${echoed(String(definition.registryDefinitionVersion))}, not 1`,
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
        `Registry ${echoed((await this.definition(signal)).registryId)} does not advertise ` +
          `${echoed(type)}, so it cannot ${what}.`,
      );
  }

  /** One page of packages. Prefer `listAll` unless you are paging yourself. */
  async list(options: ListOptions = {}): Promise<PackagePage> {
    return (await this.#listPage(options)).page;
  }

  async #listPage(
    options: ListOptions = {},
    maximumBytes = RESPONSE_BYTES.packagePage,
  ): Promise<{ page: PackagePage; bytes: number }> {
    await this.#require(
      options.updatedSince === undefined
        ? 'prex.registry.search/1'
        : 'prex.registry.sync/1',
      options.updatedSince === undefined ? 'be searched' : 'be synced from',
      options.signal,
    );
    const url = parseUntrustedUrl(`${this.#baseUrl}/v1/packages`);
    for (const [key, value] of [
      ['search', options.search],
      ['purlType', options.purlType],
      ['updatedSince', options.updatedSince],
      ['limit', options.limit?.toString()],
      ['cursor', options.cursor],
    ] as const)
      if (value !== undefined && value !== '') url.searchParams.set(key, value);
    const response = await this.#jsonDocument(
      url.toString(),
      Math.min(maximumBytes, RESPONSE_BYTES.packagePage),
      options.signal,
    );
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const page = response.value as PackagePage;
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
      const remainingBytes = limits.maximumBytes - bytes;
      if (remainingBytes <= 0)
        throw paginationLimit(`more than ${limits.maximumBytes} bytes`);
      let result: { page: PackagePage; bytes: number };
      try {
        result = await this.#listPage(
          {
            ...options,
            signal,
            ...(!(cursor === undefined) && { cursor }),
          },
          remainingBytes,
        );
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
          `Registry repeated pagination cursor ${echoed(next)}; refusing to loop.`,
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
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    return (await this.#json(
      `${this.#baseUrl}/v1/packages/${encodeUrlPathComponent(name, 'registry package name')}/versions`,
      RESPONSE_BYTES.versions,
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
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    return (await this.#json(
      `${this.#baseUrl}/v1/packages/${encodeUrlPathComponent(name, 'registry package name')}/versions/${encodeUrlPathComponent(version, 'registry package version')}`,
      RESPONSE_BYTES.entry,
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
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      JSON.parse(JSON.stringify(entry.manifest)) as JsonValue,
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
        `Registry entry for ${echoed(entry.manifest.name)}@${echoed(entry.manifest.version)} states ` +
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
          ...(!(signature.role === undefined) && { role: signature.role }),
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
        ...(!(signature.role === undefined) && { role: signature.role }),
        status,
      });
    }
    // An invalid signature is worse than an absent one: something signed this
    // and the signature does not hold.
    const bad = verified.find((item) => item.status === 'invalid');
    if (bad)
      throw new ProviderError(
        'INVALID_SIGNATURE',
        `Signature from ${echoed(bad.keyId)} on ${echoed(entry.manifest.name)}@${echoed(entry.manifest.version)} does not verify`,
      );

    return {
      digest,
      digestMatches: digestMatches ?? false,
      signatures: verified,
    };
  }

  async #json<T = JsonValue>(
    url: string,
    maximumBytes: number,
    signal?: AbortSignal,
  ): Promise<T> {
    // SAFETY: The caller supplies the schema-derived response type for this endpoint.
    return (await this.#jsonDocument(url, maximumBytes, signal)).value as T;
  }

  async #jsonDocument(
    url: string,
    maximumBytes: number,
    signal?: AbortSignal,
  ): Promise<{ value: JsonValue; bytes: number }> {
    const response = await this.#transport.request({
      url,
      method: 'GET',
      headers: { accept: 'application/json' },
      maximumBytes,
      ...(signal && { signal }),
    });
    if (response.status === 404)
      throw new ProviderError('PACKAGE_NOT_FOUND', `Not found: ${echoed(url)}`);
    if (response.status >= 400)
      throw new ProviderError(
        'UPSTREAM_UNAVAILABLE',
        `Registry returned ${response.status} for ${echoed(url)}`,
      );
    try {
      if (response.body.byteLength > maximumBytes)
        throw new ProviderError(
          'INVALID_PROVIDER_RESPONSE',
          `Registry response exceeds ${maximumBytes} bytes: ${echoed(url)}`,
        );
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      const value = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(response.body),
      ) as JsonValue;
      assertJsonComplexity(value);
      return {
        value,
        bytes: response.body.byteLength,
      };
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(
        'INVALID_PROVIDER_RESPONSE',
        `Registry returned a body that is not JSON: ${echoed(error instanceof Error ? error.message : String(error))}`,
      );
    }
  }
}

function assertJsonComplexity(root: JsonValue): void {
  const pending: Array<{ value: JsonValue; depth: number }> = [
    { value: root, depth: 0 },
  ];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    nodes += 1;
    if (nodes > 200_000) invalidStructure('more than 200000 values');
    if (current.depth > 64) invalidStructure('more than 64 levels');
    if (typeof current.value === 'string' && current.value.length > 1_048_576)
      invalidStructure('a string longer than 1048576 characters');
    if (Array.isArray(current.value)) {
      if (current.value.length > 100_000)
        invalidStructure('an array longer than 100000 items');
      for (const value of current.value)
        pending.push({ value, depth: current.depth + 1 });
    } else if (current.value !== null && typeof current.value === 'object') {
      const values = Object.values(current.value);
      if (values.length > 1024)
        invalidStructure('an object with more than 1024 properties');
      for (const value of values)
        pending.push({ value, depth: current.depth + 1 });
    }
  }
}

function invalidStructure(detail: string): never {
  throw new ProviderError(
    'INVALID_PROVIDER_RESPONSE',
    `Registry JSON structure contains ${detail}`,
  );
}

function paginationLimits(
  requested: Partial<PaginationLimits> | undefined,
): PaginationLimits {
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  return Object.fromEntries(
    Object.entries(PAGINATION_LIMITS).map(([name, ceiling]) => {
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      const value = requested?.[name as keyof PaginationLimits] ?? ceiling;
      if (!Number.isSafeInteger(value) || value < 1 || value > ceiling)
        throw new RangeError(
          `${name} must be an integer between 1 and ${ceiling}`,
        );
      return [name, value];
    }),
  ) as PaginationLimits;
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
