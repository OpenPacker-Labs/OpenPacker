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
import type {
  Digest,
  JsonValue,
  PackageManifest,
  PackagePage,
  RegistryEntry,
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
}

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
    return (await this.#json(url.toString(), options.signal)) as PackagePage;
  }

  /**
   * Every package matching the query, following cursors.
   *
   * An empty page is not the end of the walk while a cursor is present — a
   * federating registry may return one while a slow source is still answering,
   * and stopping there would silently truncate a mirror.
   */
  async *listAll(options: ListOptions = {}): AsyncGenerator<RegistryEntry> {
    let cursor = options.cursor;
    const seen = new Set<string>();
    for (;;) {
      const page = await this.list({
        ...options,
        ...(cursor === undefined ? {} : { cursor }),
      });
      for (const entry of page.packages) yield entry;
      const next = page.metadata.nextCursor;
      if (next === undefined || next === null) return;
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

    const message = new TextEncoder().encode(formatDigest(digest));
    const verified: {
      keyId: string;
      role?: 'publisher' | 'registry';
      status: 'valid' | 'invalid' | 'unknown-key';
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
      verified.push({
        keyId: signature.keyId,
        ...(signature.role === undefined ? {} : { role: signature.role }),
        status: (await verifier.verify(message, signature.signature))
          ? 'valid'
          : 'invalid',
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
      return JSON.parse(new TextDecoder().decode(response.body)) as JsonValue;
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

export interface EntryVerification {
  digest: Digest;
  /** False when the entry stated no digest to check against. */
  digestMatches: boolean;
  signatures: readonly {
    keyId: string;
    role?: 'publisher' | 'registry';
    status: 'valid' | 'invalid' | 'unknown-key';
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
