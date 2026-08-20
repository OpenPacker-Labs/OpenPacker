import { createHash } from 'node:crypto';
import {
  assertPackageIdentityMatchesRequest,
  BoundedFetchTransport,
  parsePurl,
  ProviderError,
  type CatalogProvider,
  type HttpTransport,
  type ProviderExecutable,
} from '@openpacker/adapter-core';
import { AdapterHostError } from '@openpacker/adapter-host';
import { OpmError } from './types.js';
import type { OpmManifest } from './types.js';
import { MANIFEST_NAME } from './paths.js';
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
  return safeRegistryEndpoint(endpoint, ecosystem);
}

function safeRegistryEndpoint(endpoint: string, ecosystem: string): string {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new OpmError(
      'INVALID_PROVIDER_ENDPOINT',
      `Registry endpoint for "${ecosystem}" is not a valid URL.`,
    );
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password)
    throw new OpmError(
      'INVALID_PROVIDER_ENDPOINT',
      `Registry endpoint for "${ecosystem}" must be HTTPS and contain no credentials.`,
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
  /**
   * Answer from a named source instead of the ecosystem's default adapter.
   *
   * Resolution precedence, highest first: this field (an explicit `--registry`
   * or a call-site choice), the source a project pinned in `opm.toml`, then the
   * ecosystem default. A named source that does not serve the purl type is an
   * error, not a fallback — falling back would fetch from somewhere nobody
   * asked for.
   */
  sourceId?: string;
  /** Configured endpoint selected from opm.toml. */
  endpoint?: string;
  transport?: HttpTransport;
  fetch?: typeof fetch;
  now?: () => string;
}

/** Bind a project registry selection to the endpoint the adapter will use. */
export function registryOptionsForEcosystem(
  ecosystem: string,
  manifest: Pick<OpmManifest, 'registries'>,
  requested: RegistryOptions = {},
): RegistryOptions {
  if (requested.endpoint !== undefined)
    return {
      ...requested,
      endpoint: safeRegistryEndpoint(requested.endpoint, ecosystem),
    };
  const sourceId = sourceForEcosystem(ecosystem, manifest, requested.sourceId);
  if (sourceId === undefined) return requested;
  const source = manifest.registries?.[sourceId];
  if (source === undefined) return requested;
  const { sourceId: _sourceId, ...options } = requested;
  return {
    ...options,
    endpoint: safeRegistryEndpoint(source.url, ecosystem),
  };
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
 * Which named source should answer for a purl type.
 *
 * Precedence, highest first:
 *
 * 1. `requested` — an explicit `--registry`, or a call site that already knows.
 * 2. The project's own pin: a `[registries.<id>]` whose `default_for` lists
 *    this purl type.
 * 3. Nothing, meaning the ecosystem's default adapter answers.
 *
 * Two project sources claiming the same purl type is a configuration error
 * rather than a coin flip — picking one silently is how a build starts reading
 * from a registry nobody chose.
 */
export function sourceForEcosystem(
  ecosystem: string,
  manifest: Pick<OpmManifest, 'registries'> | undefined,
  requested?: string,
): string | undefined {
  if (requested !== undefined && requested !== '') return requested;
  const claimants = Object.values(manifest?.registries ?? {}).filter((source) =>
    source.defaultFor?.some(
      (type) => type.toLowerCase() === ecosystem.toLowerCase(),
    ),
  );
  if (claimants.length > 1)
    throw new OpmError(
      'AMBIGUOUS_SOURCE',
      `More than one registry claims "${ecosystem}" in ${MANIFEST_NAME}: ` +
        `${claimants
          .map((source) => source.id)
          .sort()
          .join(', ')}. ` +
        'Give default_for to one of them, and select the other explicitly.',
    );
  return claimants[0]?.id;
}

/**
 * Catalog provider for one ecosystem — always discovery-gated.
 *
 * Missing Registry Definition resource types mean unsupported. The resolve
 * path and browse path share this gate; there is no production bypass.
 */
export async function providerFor(
  ecosystem: string,
  options: RegistryOptions = {},
  requiredResources: readonly string[] = [
    'prex.registry.package-metadata/1',
    'prex.registry.enumerate-versions/1',
  ],
): Promise<CatalogProvider> {
  return providerForWithDiscovery(ecosystem, options, requiredResources);
}

/** Fail closed when the registry definition omits a required resource. */
export async function providerForWithDiscovery(
  ecosystem: string,
  options: RegistryOptions = {},
  requiredResources: readonly string[] = ['prex.registry.package-metadata/1'],
): Promise<CatalogProvider> {
  assertOnline(ecosystem, options.offline);
  const registry = requireAdapterRegistry();
  // A named source owns its own endpoint and origin allowlist; applying the
  // ecosystem's would point a mirror at npmjs.org, or refuse the mirror's own
  // origin as unsafe.
  const named = options.sourceId !== undefined;
  const endpoint =
    options.endpoint ??
    (named || DEFAULT_REGISTRY_ENDPOINTS[ecosystem] === undefined
      ? undefined
      : registryEndpoint(ecosystem));
  if (endpoint !== undefined) safeRegistryEndpoint(endpoint, ecosystem);
  const transport =
    options.transport ??
    (endpoint
      ? new BoundedFetchTransport({
          allowedOrigins:
            options.endpoint === undefined
              ? allowedOriginsFor(ecosystem)
              : [new URL(endpoint).origin],
        })
      : undefined);
  try {
    return await registry.catalogFor(
      ecosystem,
      {
        ...(options.offline !== undefined ? { offline: options.offline } : {}),
        ...(options.sourceId === undefined
          ? {}
          : { sourceId: options.sourceId }),
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

/** Registry Definition for the same authority selected for provider traffic. */
export async function registryDefinitionFor(
  ecosystem: string,
  options: RegistryOptions = {},
) {
  const endpoint =
    options.endpoint ??
    (options.sourceId !== undefined ||
    DEFAULT_REGISTRY_ENDPOINTS[ecosystem] === undefined
      ? undefined
      : registryEndpoint(ecosystem));
  return requireAdapterRegistry().definitionFor(ecosystem, {
    offline: true,
    ...(options.sourceId === undefined ? {} : { sourceId: options.sourceId }),
    ...(endpoint === undefined
      ? {}
      : { endpoint: safeRegistryEndpoint(endpoint, ecosystem) }),
  });
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
  const candidates = await provider.enumerate(basePurl);
  for (const candidate of candidates) {
    assertPackageIdentityMatchesRequest(basePurl, { exactPurl: candidate });
    if (parsePurl(candidate).version === undefined)
      throw new OpmError(
        'UNRESOLVABLE',
        `Registry enumeration returned a non-exact package identity: ${candidate}.`,
      );
  }
  return candidates;
}

export interface RegistryArtifact {
  exactPurl: string;
  version: string;
  digest: string;
  size: number;
  mediaType: string;
  uri: string;
  bytes: Uint8Array;
  /**
   * Executables the provider declared the package to carry at inspect time.
   * Empty when it answered none (always for first-party adapters today).
   */
  bins: readonly ProviderExecutable[];
  registryId: string;
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
  const registryId = (await registryDefinitionFor(ecosystem, options))
    .registryId;
  const inspection = await provider.inspect(exactPurl);
  const inspectedPurl = inspection.package.identity.exactPurl;
  if (!inspectedPurl)
    throw new OpmError(
      'UNRESOLVABLE',
      `The ${ecosystem} registry did not resolve an exact package identity for ${exactPurl}.`,
    );
  // OCI identities are constructed from the requested repository and replace
  // a tag qualifier with a digest version; they do not consume a registry-
  // asserted package name. Other adapters must preserve the requested PURL.
  if (ecosystem !== 'oci')
    assertPackageIdentityMatchesRequest(exactPurl, {
      exactPurl: inspectedPurl,
    });
  // Fetch the immutable identity established by inspection. In particular,
  // never resolve a mutable OCI tag a second time after it was pinned.
  const record = await provider.fetchArtifactRecord(inspectedPurl);
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

  // Delegated providers answer metadata only (spec delegated-adapter.md
  // §Artifact bytes): the host fetches the bytes itself, bounded by the
  // published size and verified against the published digest. First-party
  // providers keep the bytes their own bounded transport already verified.
  if (
    provider.capabilities.extensions?.['openpacker/artifact-bytes'] ===
    'host-fetch'
  ) {
    const fetched = await fetchDelegatedArtifactBytes({
      ecosystem,
      exactPurl: inspectedPurl,
      endpoint: record.endpoint,
      uri,
      size: descriptor.size,
      digest: `${algorithm}:${value}`,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
    return {
      exactPurl: inspectedPurl,
      version: inspection.package.nativeVersion ?? '',
      digest: `${algorithm}:${value}`,
      size: fetched.size,
      mediaType: descriptor.mediaType ?? 'application/octet-stream',
      uri,
      bytes: fetched.bytes,
      bins: inspection.executables ?? [],
      registryId,
    };
  }

  const uriOrigin = new URL(uri).origin;
  const allowed = options.endpoint
    ? [new URL(safeRegistryEndpoint(options.endpoint, ecosystem)).origin]
    : DEFAULT_REGISTRY_ENDPOINTS[ecosystem] === undefined
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
    exactPurl: inspectedPurl,
    version: inspection.package.nativeVersion ?? '',
    digest: `${algorithm}:${value}`,
    size: descriptor.size ?? 0,
    mediaType: descriptor.mediaType ?? 'application/octet-stream',
    uri,
    bytes: record.rawBody,
    bins: inspection.executables ?? [],
    registryId,
  };
}

/**
 * Host-side byte acquisition for a delegated provider (spec
 * delegated-adapter.md §Artifact bytes, ADR 0040).
 *
 * The plugin is the metadata authority, never a byte proxy: the host downloads
 * from a location on the origin of the endpoint the record was answered with,
 * over HTTPS without credentials, bounded by the published size, and verifies
 * the sha256 digest before the bytes are anyone's artifact. Every gap in that
 * chain fails closed.
 */
async function fetchDelegatedArtifactBytes(input: {
  ecosystem: string;
  exactPurl: string;
  endpoint: string;
  uri: string;
  size: number | undefined;
  digest: string;
  fetch?: typeof fetch;
}): Promise<{ bytes: Uint8Array; size: number }> {
  // The published size is the download bound; without it there is no bound.
  const size = input.size;
  if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0)
    throw new OpmError(
      'UNRESOLVABLE',
      `The ${input.ecosystem} registry published no byte size for ${input.exactPurl}, ` +
        'so a host-side download cannot be bounded.',
    );
  let endpointOrigin: string;
  try {
    endpointOrigin = new URL(input.endpoint).origin;
  } catch {
    throw new OpmError(
      'UNSAFE_PATH',
      `The ${input.ecosystem} registry answered from an endpoint that is not a URL: ${input.endpoint}.`,
    );
  }
  let location: URL;
  try {
    location = new URL(input.uri);
  } catch {
    throw new OpmError(
      'UNSAFE_PATH',
      `The ${input.ecosystem} registry published an invalid download location for ${input.exactPurl}.`,
    );
  }
  if (location.protocol !== 'https:' || location.username || location.password)
    throw new OpmError(
      'UNSAFE_PATH',
      `Refusing to fetch ${input.exactPurl} from ${input.uri}: ` +
        'artifact locations must be HTTPS and carry no credentials.',
    );
  if (location.origin !== endpointOrigin)
    throw new OpmError(
      'UNSAFE_PATH',
      `${input.exactPurl} points at ${location.origin}, which is not the origin ` +
        `of the endpoint that answered for it (${endpointOrigin}).`,
    );
  const transport = new BoundedFetchTransport({
    allowedOrigins: [endpointOrigin],
    maximumBytes: size,
    ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
  });
  let body: Uint8Array;
  try {
    body = (await transport.request({ url: input.uri, maximumBytes: size }))
      .body;
  } catch (error) {
    // The transport refuses a body past the bound; surface it in the same
    // vocabulary as the under-size check below.
    if (
      error instanceof ProviderError &&
      error.code === 'UPSTREAM_RESPONSE_TOO_LARGE'
    )
      throw new OpmError(
        'SIZE_MISMATCH',
        `Registry size mismatch for ${input.exactPurl}: ` +
          `the download exceeded the published size of ${size} bytes`,
      );
    throw error;
  }
  if (body.byteLength !== size)
    throw new OpmError(
      'SIZE_MISMATCH',
      `Registry size mismatch for ${input.exactPurl}: ` +
        `expected ${size} bytes, got ${body.byteLength}`,
    );
  const actual = `sha256:${createHash('sha256').update(body).digest('hex')}`;
  if (actual !== input.digest)
    throw new OpmError(
      'DIGEST_MISMATCH',
      `Registry digest mismatch for ${input.exactPurl}: ` +
        `the ${input.ecosystem} provider reported ${input.digest}, the bytes hash to ${actual}`,
    );
  return { bytes: body, size };
}
