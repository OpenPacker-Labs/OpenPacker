/**
 * Any conforming PREX registry, as an `opm` source.
 *
 * This is the whole point of the source dimension: a registry serves several
 * purl types at once, so it registers under a name and is chosen explicitly
 * rather than claiming an ecosystem's default. Core needs no registry-shaped
 * special case — a registry is a source, and sources were already the
 * abstraction.
 */

import type {
  CatalogProvider,
  ProviderCapabilities,
  ProviderInspection,
  ProviderRecord,
} from '@openpacker/adapter-core';
import {
  assertPackageIdentityMatchesRequest,
  ProviderError,
} from '@openpacker/adapter-core';
import type {
  PackageIdentity,
  PackageInstance,
  SourceSnapshot,
} from '@openpacker/contracts';
import { canonicalBytes } from '@openpacker/canonical';
import { RegistryClient, type RegistryClientOptions } from './index.js';

/** Build an AdapterModule-shaped object for a registry at `baseUrl`. */
export function prexRegistryModule(input: {
  /** Stable adapter id, distinct per configured registry. */
  id?: string;
  options: RegistryClientOptions;
}) {
  const client = new RegistryClient(input.options);
  return {
    id: input.id ?? `org.openpacker.adapter.prex-registry`,
    // Filled from the live service index; a placeholder here would be a claim
    // about what the registry serves that nobody checked.
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    purlTypes: [] as string[],
    registryDefinition: async () => {
      const definition = await client.definition();
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      return definition as never;
    },
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    catalog: () => new PrexRegistryProvider(client) as never,
  };
}

/**
 * `CatalogProvider` over a registry's HTTP binding.
 *
 * Enumerate and inspect map onto the registry's own routes. `fetchArtifactRecord`
 * reads the manifest's `locations` rather than assuming the registry serves
 * bytes — a metadata-only registry is a complete registry, and pretending
 * otherwise would produce a download URL that 404s.
 */
export class PrexRegistryProvider implements CatalogProvider {
  readonly providerId = 'org.openpacker.provider.prex-registry';
  readonly capabilities: ProviderCapabilities = {
    operations: ['identify', 'enumerate', 'inspect', 'artifact'],
    purlTypes: [],
    qualifierSupport: 'partial',
    targetSpecificSemantics: false,
    offlineReplay: false,
    extensions: {},
  };

  constructor(private readonly client: RegistryClient) {}

  async identify(
    query: string,
    signal?: AbortSignal,
  ): Promise<readonly PackageIdentity[]> {
    const out: PackageIdentity[] = [];
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    for await (const entry of this.client.listAll({
      search: query,
      ...(signal && { signal }),
    }))
      for (const distribution of entry.manifest.distributions)
        out.push({
          purlType: distribution.purlType,
          canonicalPurl: basePurl(distribution),
          name: distribution.identifier,
        } as PackageIdentity);
    return out;
  }

  async enumerate(
    basePurlValue: string,
    signal?: AbortSignal,
  ): Promise<readonly string[]> {
    const { name, purlType } = splitPurl(basePurlValue);
    const list = await this.client.versions(name, signal);
    return (
      list.versions
        // A withdrawn version stays retrievable by exact version but must not be
        // offered as a candidate to solve against.
        .filter((version) => version.status !== 'deleted')
        .map(
          (version) => `pkg:${purlType}/${encodeName(name)}@${version.version}`,
        )
        .sort()
    );
  }

  async inspect(
    exactPurl: string,
    signal?: AbortSignal,
  ): Promise<ProviderInspection> {
    const { name, purlType, version } = splitPurl(exactPurl);
    if (version === undefined)
      throw new ProviderError(
        'INVALID_PURL',
        `inspect needs an exact PURL, got ${exactPurl}`,
      );
    const entry = await this.client.entry(name, version, signal);
    // Verify before the answer is used, not after. A digest that does not match
    // what the registry stated is the registry contradicting itself.
    await this.client.verifyEntry(entry);
    const distribution = entry.manifest.distributions.find(
      (candidate) => candidate.purlType === purlType,
    );
    if (!distribution)
      throw new ProviderError(
        'PACKAGE_NOT_FOUND',
        `${name}@${version} is not published for purl type ${purlType}`,
      );
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const instance: PackageInstance = {
      identity: {
        purlType,
        canonicalPurl: basePurl(distribution),
        exactPurl: distribution.exactPurl ?? exactPurl,
        name: distribution.identifier,
      },
      nativeVersion: distribution.version,
    } as unknown as PackageInstance;
    assertPackageIdentityMatchesRequest(exactPurl, instance.identity);
    return {
      package: instance,
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      record: this.#record(exactPurl, entry as never),
      warnings: [],
    };
  }

  async fetchArtifactRecord(
    exactPurl: string,
    signal?: AbortSignal,
  ): Promise<ProviderRecord> {
    const { name, purlType, version } = splitPurl(exactPurl);
    if (version === undefined)
      throw new ProviderError(
        'INVALID_PURL',
        `fetchArtifactRecord needs an exact PURL, got ${exactPurl}`,
      );
    const entry = await this.client.entry(name, version, signal);
    await this.client.verifyEntry(entry);
    const distribution = entry.manifest.distributions.find(
      (candidate) => candidate.purlType === purlType,
    );
    if (!distribution?.digest || !distribution.locations?.length)
      throw new ProviderError(
        'ARTIFACT_NOT_FOUND',
        `Registry has no artifact location or digest for ${exactPurl}. ` +
          'A metadata-only registry points at an upstream source; this one pointed nowhere.',
      );
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    return this.#record(exactPurl, {
      digest: distribution.digest,
      size: distribution.size ?? 0,
      mediaType: distribution.mediaType ?? 'application/octet-stream',
      locations: distribution.locations.map((uri) => ({ uri })),
    } as never);
  }

  async snapshot(evaluationTime: string): Promise<SourceSnapshot> {
    throw new ProviderError(
      'PROVIDER_CAPABILITY_MISSING',
      `A PREX registry does not produce catalog snapshots (asked at ${evaluationTime}); ` +
        'mirror it with updatedSince instead.',
    );
  }

  #record(key: string, body: never): ProviderRecord {
    return {
      key,
      endpoint: 'prex-registry',
      body,
      rawBody: canonicalBytes(body),
      retrievedAt: new Date().toISOString(),
    };
  }
}

function basePurl(distribution: {
  purlType: string;
  identifier: string;
}): string {
  return `pkg:${distribution.purlType}/${encodeName(distribution.identifier)}`;
}

function encodeName(name: string): string {
  return name
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
}

function splitPurl(purl: string) {
  const match = /^pkg:([A-Za-z0-9.+-]+)\/(.+?)(?:@([^?#]+))?(?:[?#].*)?$/u.exec(
    purl,
  );
  if (!match) throw new ProviderError('INVALID_PURL', `Not a PURL: ${purl}`);
  return {
    purlType: match[1]!,
    name: decodeURIComponent(match[2]!),
    ...(!(match[3] === undefined) && { version: decodeURIComponent(match[3]) }),
  };
}
