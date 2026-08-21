/**
 * Federation: serve packages this registry does not hold.
 *
 * An operator wants one index over sources they do not own — npm, an internal
 * feed, another PREX registry. That needs no new machinery, because the
 * plug-in that lets `opm` reach npm is the same one a registry uses. This is
 * the existing abstraction pointed the other way.
 *
 * Two rules keep it honest. A relayed entry is tagged with the `sourceId` it
 * came from, so a consumer can always tell what the registry holds from what
 * it is passing along. And the local store wins on a name collision — an
 * upstream that starts publishing a name you already publish must not
 * silently take it over.
 */

import type {
  JsonValue,
  PackageManifest,
  RegistryEntry,
} from '@openpacker/contracts';
import { RegistryClient } from '@openpacker/registry-client';
import { ProviderError, type CatalogProvider } from '@openpacker/adapter-core';
import { createPrexValidator, validateContract } from '@openpacker/conformance';

const REGISTRY_ENTRY_SCHEMA =
  'https://openpacker.dev/spec/prex/v1/schemas/registry-api.schema.json#/$defs/RegistryEntry';

export type SourceSpec =
  /** Packages published to this registry. Always present, always first. */
  | { kind: 'published' }
  /** Another PREX registry, read through the ordinary client. */
  | { kind: 'prex'; url: string }
  /**
   * An upstream ecosystem through an adapter's CatalogProvider — the same
   * object `opm` uses to reach npmjs.org.
   */
  | { kind: 'adapter'; purlType: string; provider: CatalogProvider };

export interface ConfiguredSource {
  id: string;
  spec: SourceSpec;
}

export interface FederationOptions {
  sources: readonly ConfiguredSource[];
  registryId: string;
  /**
   * How to reach an upstream registry.
   *
   * Injectable because a deployment wants one shared transport with its own
   * timeouts and credentials, and because a federation that can only build its
   * own client cannot be driven against an in-process instance — which would
   * mean the relay path is only ever tested by a stand-in for itself.
   */
  clientFactory?: (source: { id: string; url: string }) => RegistryClient;
}

/**
 * Query configured sources for entries the local store did not answer.
 *
 * Failures are per-source and reported, not thrown: one upstream being down
 * should degrade the index, not take it offline. What is *not* done is
 * pretending the result is complete — `unavailable` names every source that
 * did not answer so a caller can tell a miss from an outage.
 */
export class Federation {
  readonly #sources: readonly ConfiguredSource[];
  readonly #clients = new Map<string, RegistryClient>();
  readonly #validator = createPrexValidator();

  constructor(private readonly options: FederationOptions) {
    this.#sources = options.sources.filter(
      (source) => source.spec.kind !== 'published',
    );
  }

  get sourceIds(): readonly string[] {
    return this.#sources.map((source) => source.id);
  }

  /** Every purl type the configured sources say they serve. */
  async purlTypes(): Promise<readonly string[]> {
    const out = new Set<string>();
    for (const source of this.#sources) {
      if (source.spec.kind === 'adapter') {
        out.add(source.spec.purlType);
        continue;
      }
      if (source.spec.kind !== 'prex') continue;
      const url = source.spec.url;
      try {
        for (const type of (await this.#client(source.id, url)).purlTypes ?? [])
          out.add(type);
      } catch {
        // A source that cannot be reached at start-up contributes nothing to
        // the advertised set rather than blocking the index from starting.
      }
    }
    return [...out].sort();
  }

  /**
   * Find one package version upstream.
   *
   * First answer wins, in configuration order, so precedence is something the
   * operator wrote down rather than a race.
   */
  async find(
    name: string,
    version: string,
  ): Promise<{ entry: RegistryEntry; sourceId: string } | undefined> {
    for (const source of this.#sources) {
      if (source.spec.kind !== 'prex') continue;
      try {
        const client = await this.#clientFor(source.id, source.spec.url);
        const entry = await client.entry(name, version);
        // Verify before relaying. Passing along something whose digest does
        // not match would launder an upstream's contradiction into this
        // registry's own answer.
        await this.#verifyEntry(client, entry);
        this.#assertExactIdentity(name, version, entry);
        return { entry: this.#tag(entry, source.id), sourceId: source.id };
      } catch {
        // Not here, or not reachable. Try the next source.
      }
    }
    return undefined;
  }

  /** Search every source, tagging each result with where it came from. */
  async search(
    query: string,
    limit: number,
  ): Promise<{
    entries: RegistryEntry[];
    unavailable: { sourceId: string; reason: string }[];
  }> {
    const entries: RegistryEntry[] = [];
    const unavailable: { sourceId: string; reason: string }[] = [];
    for (const source of this.#sources) {
      if (source.spec.kind !== 'prex') continue;
      try {
        const client = await this.#clientFor(source.id, source.spec.url);
        for await (const entry of client.listAll({ search: query, limit })) {
          await this.#verifyEntry(client, entry);
          entries.push(this.#tag(entry, source.id));
          if (entries.length >= limit) break;
        }
      } catch (error) {
        unavailable.push({
          sourceId: source.id,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      if (entries.length >= limit) break;
    }
    return { entries, unavailable };
  }

  /**
   * Restate a relayed entry as this registry's answer, without laundering it.
   *
   * `registryId` becomes this registry — it is the one answering — but
   * `sourceId` records who actually holds it, and the upstream's signatures
   * are carried through untouched so they still verify against the upstream's
   * key rather than this one's.
   */
  #tag(entry: RegistryEntry, sourceId: string): RegistryEntry {
    return {
      ...entry,
      registryMetadata: {
        ...entry.registryMetadata,
        registryId: this.options.registryId,
        sourceId,
      },
    };
  }

  async #verifyEntry(
    client: RegistryClient,
    entry: RegistryEntry,
  ): Promise<void> {
    const contract = validateContract(
      REGISTRY_ENTRY_SCHEMA,
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      entry as unknown as JsonValue,
      this.#validator,
    );
    if (!contract.valid)
      throw new ProviderError(
        'INVALID_PROVIDER_RESPONSE',
        'Federated registry returned an invalid RegistryEntry',
      );
    const verification = await client.verifyEntry(entry);
    if (!verification.digestMatches)
      throw new ProviderError(
        'INVALID_PROVIDER_RESPONSE',
        'Federated registry entry has no verifiable manifest digest',
      );
    if (
      verification.signatures.some(
        (signature) => signature.status === 'revoked',
      )
    )
      throw new ProviderError(
        'INVALID_SIGNATURE',
        'Federated registry entry is signed by a revoked key',
      );
  }

  #assertExactIdentity(
    name: string,
    version: string,
    entry: RegistryEntry,
  ): void {
    if (entry.manifest.name !== name || entry.manifest.version !== version)
      throw new ProviderError(
        'INVALID_PROVIDER_RESPONSE',
        `Federated registry returned ${entry.manifest.name}@${entry.manifest.version} for ${name}@${version}`,
      );
    for (const distribution of entry.manifest.distributions) {
      if (
        distribution.version !== version ||
        typeof distribution.exactPurl !== 'string' ||
        exactPurlVersion(distribution.exactPurl) !== distribution.version
      )
        throw new ProviderError(
          'INVALID_PROVIDER_RESPONSE',
          `Federated distribution ${distribution.exactPurl} is not bound to ${name}@${version}`,
        );
    }
  }

  async #clientFor(id: string, url: string): Promise<RegistryClient> {
    const existing = this.#clients.get(id);
    if (existing) return existing;
    const client =
      this.options.clientFactory?.({ id, url }) ??
      new RegistryClient({ baseUrl: url });
    this.#clients.set(id, client);
    return client;
  }

  async #client(id: string, url: string) {
    return (await this.#clientFor(id, url)).definition();
  }
}

function exactPurlVersion(exactPurl: string): string | undefined {
  const identity = exactPurl.split(/[?#]/u, 1)[0] ?? '';
  const separator = identity.lastIndexOf('@');
  if (separator < 4 || separator === identity.length - 1) return undefined;
  try {
    return decodeURIComponent(identity.slice(separator + 1));
  } catch {
    return undefined;
  }
}

/** True when a manifest names something this registry itself publishes. */
export function isLocal(
  local: (name: string, version: string) => unknown,
  manifest: Pick<PackageManifest, 'name' | 'version'>,
): boolean {
  return local(manifest.name, manifest.version) !== undefined;
}
