import {
  BoundedFetchTransport,
  type CatalogProvider,
  type HttpTransport,
} from '@openpacker/adapter-core';
import { AdapterHostError } from '@openpacker/adapter-host';
import { OpmError } from './types.js';
import { requireAdapterRegistry } from './adapters.js';

/**
 * Resolving a PURL against the ecosystem's real registry.
 *
 * Providers are obtained from the adapter host (capability discovery +
 * registration). Offline still refuses network reads; transports stay
 * origin-allowlisted.
 */

/**
 * Default endpoints used when synthesising Registry Definitions and
 * allowlists. Overrides via `OPM_REGISTRY_<ECOSYSTEM>` still apply.
 */
export const DEFAULT_REGISTRY_ENDPOINTS: Readonly<Record<string, string>> = {
  npm: 'https://registry.npmjs.org',
  cargo: 'https://index.crates.io',
  pypi: 'https://pypi.org/pypi',
  nuget: 'https://api.nuget.org/v3/index.json',
  maven: 'https://repo1.maven.org/maven2',
  golang: 'https://proxy.golang.org',
  oci: 'https://registry-1.docker.io',
};

/**
 * PURL types whose adapters export a catalog provider.
 *
 * Driven by discovery (module.catalog), not a hardwired ecosystem name list.
 */
export function registryEcosystems(): readonly string[] {
  return requireAdapterRegistry()
    .list()
    .filter((module) => typeof module.catalog === 'function')
    .flatMap((module) => module.purlTypes)
    .map((type) => type.toLowerCase())
    .sort();
}

/**
 * Snapshot of catalog purl types at first read when a registry is configured.
 * Prefer {@link registryEcosystems} for live discovery.
 *
 * @deprecated Use registryEcosystems().
 */
export const REGISTRY_ECOSYSTEMS: readonly string[] = Object.freeze([
  'npm',
  'cargo',
  'pypi',
  'nuget',
  'maven',
  'golang',
  'oci',
]);

const ARTIFACT_ORIGINS: Readonly<Record<string, readonly string[]>> = {
  npm: ['https://registry.npmjs.org'],
  cargo: ['https://static.crates.io', 'https://crates.io'],
  pypi: ['https://files.pythonhosted.org', 'https://pypi.org'],
  nuget: ['https://api.nuget.org', 'https://globalcdn.nuget.org'],
  maven: ['https://repo1.maven.org', 'https://repo.maven.apache.org'],
  golang: ['https://proxy.golang.org'],
  oci: ['https://registry-1.docker.io', 'https://ghcr.io'],
};

export function registryEndpoint(ecosystem: string): string {
  const override =
    process.env[`OPM_REGISTRY_${ecosystem.toUpperCase()}`]?.trim();
  const endpoint = override || DEFAULT_REGISTRY_ENDPOINTS[ecosystem];
  if (!endpoint)
    throw new OpmError(
      'UNSUPPORTED_ECOSYSTEM',
      `No registry endpoint is configured for "${ecosystem}".`,
    );
  return endpoint;
}

export function allowedOriginsFor(ecosystem: string): string[] {
  const endpoint = registryEndpoint(ecosystem);
  return [
    ...new Set([
      new URL(endpoint).origin,
      ...(ARTIFACT_ORIGINS[ecosystem] ?? []).map((uri) => new URL(uri).origin),
    ]),
  ];
}

export interface RegistryOptions {
  offline?: boolean;
  transport?: HttpTransport;
  fetch?: typeof fetch;
  now?: () => string;
}

function assertOnline(ecosystem: string, offline: boolean | undefined): void {
  if (offline)
    throw new OpmError(
      'OFFLINE',
      `Refusing to read the ${ecosystem} registry while offline. ` +
        `Use a catalog entry or --source, or drop --offline.`,
    );
}

function mapHostError(error: unknown): never {
  if (error instanceof AdapterHostError)
    throw new OpmError(error.code, error.message);
  throw error;
}

/**
 * A catalog provider for one ecosystem, from the adapter registry.
 */
export function providerFor(
  ecosystem: string,
  options: RegistryOptions = {},
): CatalogProvider {
  assertOnline(ecosystem, options.offline);
  const registry = requireAdapterRegistry();
  try {
    // Synchronous path for callers that already hold a provider; catalog
    // factories are sync. Resource checks happen in the async helper.
    const module = registry.moduleFor(ecosystem);
    if (!module.catalog)
      throw new OpmError(
        'UNSUPPORTED_ECOSYSTEM',
        `No catalog provider for "${ecosystem}".`,
      );
    const endpoint =
      DEFAULT_REGISTRY_ENDPOINTS[ecosystem] === undefined
        ? undefined
        : registryEndpoint(ecosystem);
    const transport =
      options.transport ??
      (endpoint
        ? new BoundedFetchTransport({
            allowedOrigins: allowedOriginsFor(ecosystem),
          })
        : undefined);
    return module.catalog({
      ...(options.offline !== undefined ? { offline: options.offline } : {}),
      ...(endpoint === undefined ? {} : { endpoint }),
      ...(transport === undefined ? {} : { transport }),
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
  } catch (error) {
    mapHostError(error);
  }
}

/** Fail closed when the registry definition omits a required resource. */
export async function providerForWithDiscovery(
  ecosystem: string,
  options: RegistryOptions = {},
  requiredResources: readonly string[] = ['prex.registry.package-metadata/1'],
): Promise<CatalogProvider> {
  assertOnline(ecosystem, options.offline);
  const registry = requireAdapterRegistry();
  const endpoint =
    DEFAULT_REGISTRY_ENDPOINTS[ecosystem] === undefined
      ? undefined
      : registryEndpoint(ecosystem);
  const transport =
    options.transport ??
    (endpoint
      ? new BoundedFetchTransport({
          allowedOrigins: allowedOriginsFor(ecosystem),
        })
      : undefined);
  try {
    return await registry.catalogFor(
      ecosystem,
      {
        ...(options.offline !== undefined ? { offline: options.offline } : {}),
        ...(endpoint === undefined ? {} : { endpoint }),
        ...(transport === undefined ? {} : { transport }),
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.now ? { now: options.now } : {}),
      },
      requiredResources,
    );
  } catch (error) {
    mapHostError(error);
  }
}

export async function searchRegistry(
  ecosystem: string,
  query: string,
  options: RegistryOptions = {},
): Promise<{ canonicalPurl: string; name: string; namespace?: string }[]> {
  const registry = requireAdapterRegistry();
  if (!(await registry.supportsSearch(ecosystem, options)))
    throw new OpmError(
      'UNSUPPORTED_OPERATION',
      `Registry for "${ecosystem}" does not advertise prex.registry.search/1`,
    );
  const provider = await providerForWithDiscovery(ecosystem, options, [
    'prex.registry.search/1',
  ]);
  // Some catalogs implement identify as search.
  const found = await provider.identify(query);
  return found.map((identity) => ({
    canonicalPurl: identity.canonicalPurl,
    name: identity.name,
    ...(identity.namespace === undefined
      ? {}
      : { namespace: identity.namespace }),
  }));
}

export async function listRegistryVersions(
  ecosystem: string,
  basePurl: string,
  options: RegistryOptions = {},
): Promise<readonly string[]> {
  const provider = await providerForWithDiscovery(ecosystem, options, [
    'prex.registry.enumerate-versions/1',
  ]);
  return provider.enumerate(basePurl);
}

export interface RegistryArtifact {
  exactPurl: string;
  version: string;
  digest: string;
  size: number;
  mediaType: string;
  uri: string;
  bytes: Uint8Array;
}

export async function resolveRegistryArtifact(
  ecosystem: string,
  exactPurl: string,
  options: RegistryOptions = {},
): Promise<RegistryArtifact> {
  const provider = await providerForWithDiscovery(ecosystem, options, [
    'prex.registry.package-metadata/1',
    'prex.registry.artifact/1',
  ]);
  const inspection = await provider.inspect(exactPurl);
  const record = await provider.fetchArtifactRecord(exactPurl);
  const descriptor = record.body as {
    digest?: { algorithm?: string; value?: string };
    size?: number;
    mediaType?: string;
    locations?: readonly { uri?: string }[];
  };

  const algorithm = descriptor.digest?.algorithm;
  const value = descriptor.digest?.value;
  if (algorithm !== 'sha256' || !value)
    throw new OpmError(
      'UNRESOLVABLE',
      `The ${ecosystem} registry did not publish a sha256 digest for ${exactPurl}, ` +
        `so the download cannot be verified. Pass --source with a digest you trust.`,
    );

  const uri = descriptor.locations?.find((location) => location.uri)?.uri;
  if (!uri)
    throw new OpmError(
      'UNRESOLVABLE',
      `The ${ecosystem} registry published no download location for ${exactPurl}.`,
    );
  const uriOrigin = new URL(uri).origin;
  const allowed =
    DEFAULT_REGISTRY_ENDPOINTS[ecosystem] === undefined
      ? [uriOrigin]
      : allowedOriginsFor(ecosystem);
  const ociNamed = ecosystem === 'oci' && uriOrigin.startsWith('https://');
  if (!allowed.includes(uriOrigin) && !ociNamed)
    throw new OpmError(
      'UNSAFE_PATH',
      `${exactPurl} points at ${uriOrigin}, which is not an allowed ` +
        `origin for ${ecosystem} (${allowed.join(', ')}).`,
    );

  return {
    exactPurl: inspection.package.identity.exactPurl ?? exactPurl,
    version: inspection.package.nativeVersion ?? '',
    digest: `${algorithm}:${value}`,
    size: descriptor.size ?? 0,
    mediaType: descriptor.mediaType ?? 'application/octet-stream',
    uri,
    bytes: record.rawBody,
  };
}
