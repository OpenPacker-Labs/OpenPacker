/**
 * The `opm-plugin` adapter: any PREX registry as a source of delegated
 * adapter plugins.
 *
 * Version 1 defines no remote plugin discovery — a plugin name resolves to
 * `pkg:opm-plugin/<name>` and nothing else, and the registry that answers is
 * the one the operator configured (`OPM_REGISTRY_OPM_PLUGIN`, or an explicit
 * endpoint from the caller). The module is registered lazily by the store the
 * first time a plugin operation needs it; nothing here runs at import time.
 *
 * The provider downloads artifact bytes itself (that is what
 * `fetchArtifactRecord` means for every first-party adapter) and verifies them
 * against the digest the registry published before anything downstream sees
 * them. Callers still re-hash before materialization; this is the first
 * fail-closed gate, not the only one.
 */

import { createHash } from 'node:crypto';
import {
  assertPackageIdentityMatchesRequest,
  BoundedFetchTransport,
  ProviderError,
  type CatalogProvider,
  type HttpTransport,
  type ProviderCapabilities,
  type ProviderInspection,
  type ProviderRecord,
} from '@openpacker/adapter-core';
import type {
  AdapterContext,
  AdapterModule,
  RegistryDefinition,
} from '@openpacker/adapter-host';
import type {
  Digest,
  JsonValue,
  LifecycleState,
  PackageIdentity,
  PackageInstance,
  RegistryEntry,
  SourceSnapshot,
} from '@openpacker/contracts';
import { canonicalBytes } from '@openpacker/canonical';
import { RegistryClient } from '@openpacker/registry-client';
import { OpmError } from '@openpacker/opm-project';

/** Reserved purl type for delegated adapter plugin packages. */
export const PLUGIN_PURL_TYPE = 'opm-plugin';

/** Environment variable naming the plugin registry endpoint. */
export const PLUGIN_REGISTRY_ENDPOINT_ENV = 'OPM_REGISTRY_OPM_PLUGIN';

/**
 * Plugin artifacts are a manifest plus a standalone executable; none is
 * legitimately large. Bounded at the materializer's compressed-artifact
 * ceiling so a hostile registry cannot stream unbounded bytes.
 */
export const MAX_PLUGIN_ARTIFACT_BYTES = 64 * 1024 * 1024;

/** The configured plugin registry endpoint, when one is set. */
export function pluginRegistryEndpoint(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const value = env[PLUGIN_REGISTRY_ENDPOINT_ENV]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

export function requirePluginRegistryEndpoint(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const endpoint = pluginRegistryEndpoint(env);
  if (endpoint === undefined)
    throw new OpmError(
      'PLUGIN_REGISTRY_UNCONFIGURED',
      'No plugin registry is configured. Set ' +
        `${PLUGIN_REGISTRY_ENDPOINT_ENV}=https://<registry> to the PREX ` +
        'registry that publishes pkg:opm-plugin/* packages.',
    );
  return endpoint;
}

export interface PluginRegistryModuleOptions {
  /** Default endpoint; an AdapterContext endpoint still wins. */
  endpoint?: string;
  transport?: HttpTransport;
  fetch?: typeof fetch;
}

/**
 * Adapter module serving `pkg:opm-plugin/*` from one PREX registry.
 *
 * Registered under the purl type (not a named source): the plugin store owns
 * the `opm-plugin` type by design, and there is no first-party adapter for it
 * to displace.
 */
export function pluginRegistryModule(
  defaults: PluginRegistryModuleOptions = {},
): AdapterModule {
  const clientFor = (context?: AdapterContext): RegistryClient => {
    const endpoint =
      context?.endpoint ?? defaults.endpoint ?? requirePluginRegistryEndpoint();
    const transport =
      (context?.transport as HttpTransport | undefined) ?? defaults.transport;
    const fetch = context?.fetch ?? defaults.fetch;
    return new RegistryClient({
      baseUrl: endpoint,
      ...(transport === undefined ? {} : { transport }),
      ...(fetch === undefined ? {} : { fetch }),
    });
  };
  return {
    id: 'org.openpacker.adapter.opm-plugin',
    purlTypes: [PLUGIN_PURL_TYPE],
    registryDefinition: async (context) =>
      registryDefinitionOf(await clientFor(context).definition()),
    catalog: (context) =>
      new PluginRegistryProvider(
        clientFor(context),
        context?.endpoint ?? defaults.endpoint,
        (context?.transport as HttpTransport | undefined) ?? defaults.transport,
      ),
  };
}

function registryDefinitionOf(definition: {
  registryDefinitionVersion: string;
  registryId: string;
  displayName?: string;
  purlTypes: readonly string[];
  resources: readonly { '@id': string; '@type': string | readonly string[] }[];
}): RegistryDefinition {
  return {
    registryDefinitionVersion: '1',
    registryId: definition.registryId,
    ...(definition.displayName === undefined
      ? {}
      : { displayName: definition.displayName }),
    purlTypes: [...definition.purlTypes],
    resources: definition.resources.map((resource) => ({
      '@id': resource['@id'],
      '@type': resource['@type'],
    })),
  };
}

interface PluginPurl {
  name: string;
  version?: string;
}

function splitPluginPurl(purl: string): PluginPurl {
  const match = /^pkg:opm-plugin\/(.+?)(?:@([^?#]+))?(?:[?#].*)?$/u.exec(purl);
  if (!match)
    throw new ProviderError('INVALID_PURL', `Not an opm-plugin PURL: ${purl}`);
  return {
    name: decodeURIComponent(match[1]!),
    ...(match[2] === undefined
      ? {}
      : { version: decodeURIComponent(match[2]) }),
  };
}

function encodeName(name: string): string {
  return name
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
}

/** Registry lifecycle status mapped onto the honest LifecycleState vocabulary. */
function lifecycleOf(entry: RegistryEntry): LifecycleState {
  switch (entry.registryMetadata.status) {
    case 'active':
      return { status: 'published', eligible: true, warnings: [] };
    case 'deprecated':
      return { status: 'deprecated', eligible: false, warnings: [] };
    case 'deleted':
      return { status: 'delisted', eligible: false, warnings: [] };
  }
}

function distributionFor(
  entry: RegistryEntry,
  exactPurl: string,
): RegistryEntry['manifest']['distributions'][number] {
  const distribution = entry.manifest.distributions.find(
    (candidate) => candidate.purlType === PLUGIN_PURL_TYPE,
  );
  if (!distribution)
    throw new ProviderError(
      'PACKAGE_NOT_FOUND',
      `${entry.manifest.name}@${entry.manifest.version} is not published as ${PLUGIN_PURL_TYPE}`,
    );
  const identity: PackageIdentity = {
    purlType: PLUGIN_PURL_TYPE,
    canonicalPurl: `pkg:${PLUGIN_PURL_TYPE}/${encodeName(distribution.identifier)}`,
    exactPurl: distribution.exactPurl ?? exactPurl,
    name: distribution.identifier,
  } as PackageIdentity;
  assertPackageIdentityMatchesRequest(exactPurl, identity);
  return distribution;
}

/**
 * `CatalogProvider` over a plugin registry's HTTP binding.
 *
 * Unlike the generic PREX provider, `fetchArtifactRecord` returns the artifact
 * bytes themselves (digest-verified against the distribution descriptor), so
 * the standard `resolveRegistryArtifact` path works unchanged.
 */
export class PluginRegistryProvider implements CatalogProvider {
  readonly providerId = 'org.openpacker.provider.opm-plugin';
  readonly capabilities: ProviderCapabilities = {
    operations: ['identify', 'enumerate', 'inspect', 'artifact'],
    purlTypes: [PLUGIN_PURL_TYPE],
    qualifierSupport: 'partial',
    targetSpecificSemantics: false,
    offlineReplay: false,
    extensions: {},
  };

  readonly #client: RegistryClient;
  readonly #endpoint: string;
  readonly #artifacts: HttpTransport;

  constructor(
    client: RegistryClient,
    endpoint: string | undefined,
    transport?: HttpTransport,
  ) {
    this.#client = client;
    this.#endpoint = endpoint ?? requirePluginRegistryEndpoint();
    this.#artifacts =
      transport ??
      new BoundedFetchTransport({
        allowedOrigins: [new URL(this.#endpoint).origin],
        maximumBytes: MAX_PLUGIN_ARTIFACT_BYTES,
      });
  }

  async identify(
    query: string,
    signal?: AbortSignal,
  ): Promise<readonly PackageIdentity[]> {
    const out: PackageIdentity[] = [];
    for await (const entry of this.#client.listAll({
      search: query,
      purlType: PLUGIN_PURL_TYPE,
      ...(signal ? { signal } : {}),
    }))
      for (const distribution of entry.manifest.distributions)
        if (distribution.purlType === PLUGIN_PURL_TYPE)
          out.push({
            purlType: PLUGIN_PURL_TYPE,
            canonicalPurl: `pkg:${PLUGIN_PURL_TYPE}/${encodeName(distribution.identifier)}`,
            name: distribution.identifier,
          } as PackageIdentity);
    return out;
  }

  async enumerate(
    basePurlValue: string,
    signal?: AbortSignal,
  ): Promise<readonly string[]> {
    const { name } = splitPluginPurl(basePurlValue);
    const list = await this.#client.versions(name, signal);
    return list.versions
      .filter((version) => version.status !== 'deleted')
      .map(
        (version) =>
          `pkg:${PLUGIN_PURL_TYPE}/${encodeName(name)}@${version.version}`,
      )
      .sort();
  }

  async inspect(
    exactPurl: string,
    signal?: AbortSignal,
  ): Promise<ProviderInspection> {
    const { name, version } = splitPluginPurl(exactPurl);
    if (version === undefined)
      throw new ProviderError(
        'INVALID_PURL',
        `inspect needs an exact PURL, got ${exactPurl}`,
      );
    const entry = await this.#client.entry(name, version, signal);
    await this.#client.verifyEntry(entry);
    const distribution = distributionFor(entry, exactPurl);
    const instance = {
      identity: {
        purlType: PLUGIN_PURL_TYPE,
        canonicalPurl: `pkg:${PLUGIN_PURL_TYPE}/${encodeName(distribution.identifier)}`,
        exactPurl: distribution.exactPurl ?? exactPurl,
        name: distribution.identifier,
      },
      nativeVersion: distribution.version,
      lifecycle: lifecycleOf(entry),
      semanticLoss: [],
      sourceSnapshots: [],
    } as unknown as PackageInstance;
    return {
      package: instance,
      record: {
        key: exactPurl,
        endpoint: this.#endpoint,
        body: entry,
        rawBody: canonicalBytes(entry as unknown as JsonValue),
        retrievedAt: new Date().toISOString(),
      },
      warnings: [],
    };
  }

  async fetchArtifactRecord(
    exactPurl: string,
    signal?: AbortSignal,
  ): Promise<ProviderRecord> {
    const { name, version } = splitPluginPurl(exactPurl);
    if (version === undefined)
      throw new ProviderError(
        'INVALID_PURL',
        `fetchArtifactRecord needs an exact PURL, got ${exactPurl}`,
      );
    const entry = await this.#client.entry(name, version, signal);
    await this.#client.verifyEntry(entry);
    const distribution = distributionFor(entry, exactPurl);
    if (!distribution.digest || !distribution.locations?.length)
      throw new ProviderError(
        'ARTIFACT_NOT_FOUND',
        `Registry has no artifact location or digest for ${exactPurl}.`,
      );
    const uri = distribution.locations[0]!;
    const bytes = await this.#download(uri, distribution, signal);
    const body = {
      digest: distribution.digest,
      size: distribution.size ?? bytes.byteLength,
      mediaType: distribution.mediaType ?? 'application/octet-stream',
      locations: distribution.locations.map((location) => ({ uri: location })),
    };
    return {
      key: exactPurl,
      endpoint: this.#endpoint,
      body,
      rawBody: bytes,
      retrievedAt: new Date().toISOString(),
    };
  }

  async #download(
    uri: string,
    distribution: { digest?: Digest; size?: number },
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const response = await this.#artifacts.request({
      url: uri,
      method: 'GET',
      headers: { accept: 'application/octet-stream' },
      maximumBytes: MAX_PLUGIN_ARTIFACT_BYTES,
      ...(signal ? { signal } : {}),
    });
    if (response.status === 404)
      throw new ProviderError('ARTIFACT_NOT_FOUND', `Not found: ${uri}`);
    if (response.status >= 400)
      throw new ProviderError(
        'UPSTREAM_UNAVAILABLE',
        `Plugin artifact fetch returned ${response.status} for ${uri}`,
      );
    const bytes = response.body;
    if (bytes.byteLength > MAX_PLUGIN_ARTIFACT_BYTES)
      throw new ProviderError(
        'UPSTREAM_RESPONSE_TOO_LARGE',
        `Plugin artifact exceeds ${MAX_PLUGIN_ARTIFACT_BYTES} bytes: ${uri}`,
      );
    if (
      distribution.size !== undefined &&
      bytes.byteLength !== distribution.size
    )
      throw new ProviderError(
        'SIZE_MISMATCH',
        `Plugin artifact has ${bytes.byteLength} bytes, the registry published ${distribution.size}`,
      );
    const digest = distribution.digest;
    if (digest?.algorithm !== 'sha256' || digest.value === undefined)
      throw new ProviderError(
        'UNRESOLVABLE',
        'The plugin registry did not publish a sha256 digest, so the download cannot be verified.',
      );
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== digest.value)
      throw new ProviderError(
        'DIGEST_MISMATCH',
        `Plugin artifact hashes to sha256:${actual}, the registry published sha256:${digest.value}`,
      );
    return bytes;
  }

  async snapshot(evaluationTime: string): Promise<SourceSnapshot> {
    throw new ProviderError(
      'PROVIDER_CAPABILITY_MISSING',
      `A plugin registry does not produce catalog snapshots (asked at ${evaluationTime}).`,
    );
  }
}
