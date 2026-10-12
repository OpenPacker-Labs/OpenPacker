import { createHash } from 'node:crypto';
import {
  assertPackageIdentityMatchesRequest,
  BoundedFetchTransport,
  createFirstPartyTransport,
  firstPartyOriginPolicy,
  normalizePinnedOrigin,
  parseHttpsOriginList,
  parsePurl,
  ProviderError,
  redactUrl,
  type CatalogProvider,
  type HostLookup,
  type HttpRequest,
  type HttpResponse,
  type HttpTransport,
  type ProviderAttestation,
  type ProviderExecutable,
  type ProviderInspection,
} from '@openpacker/adapter-core';
import type { JsonValue } from '@openpacker/contracts';
import { AdapterHostError } from '@openpacker/adapter-host';
import { OpmError } from './types.js';
import type { OpmLockfile, OpmManifest, PluginBinding } from './types.js';
import { MANIFEST_NAME } from './paths.js';
import { requireAdapterRegistry } from './adapters.js';
import { stripPurlVersion } from './spec.js';

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
type RegistryEndpointMap = Record<string, string>;
type RegistryOriginMap = Record<string, readonly string[]>;

const DEFAULT_REGISTRY_ENDPOINT_VALUES: RegistryEndpointMap = {
  npm: 'https://registry.npmjs.org',
  cargo: 'https://index.crates.io',
  pypi: 'https://pypi.org/pypi',
  nuget: 'https://api.nuget.org/v3/index.json',
  maven: 'https://repo1.maven.org/maven2',
  golang: 'https://proxy.golang.org',
  oci: 'https://registry-1.docker.io',
} satisfies RegistryEndpointMap;

export const DEFAULT_REGISTRY_ENDPOINTS = DEFAULT_REGISTRY_ENDPOINT_VALUES;

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

const ARTIFACT_ORIGINS: RegistryOriginMap = {
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

function registryEndpointIsOverride(ecosystem: string): boolean {
  const value = process.env[`OPM_REGISTRY_${ecosystem.toUpperCase()}`]?.trim();
  return value !== undefined && value !== '';
}

function parseRegistryExtraOrigins(ecosystem: string): string[] {
  const envName = `OPM_REGISTRY_${ecosystem.toUpperCase()}_ORIGINS`;
  try {
    return parseHttpsOriginList(process.env[envName], envName);
  } catch (error) {
    if (
      error instanceof ProviderError &&
      error.code === 'INVALID_PROVIDER_ENDPOINT'
    )
      throw new OpmError('INVALID_PROVIDER_ENDPOINT', error.message);
    throw error;
  }
}

function firstPartyPolicy(
  ecosystem: string,
  options: RegistryOptions = {},
): { allowedOrigins: string[]; pinnedOrigins: string[] } {
  const endpoint =
    options.endpoint !== undefined
      ? safeRegistryEndpoint(options.endpoint, ecosystem)
      : registryEndpoint(ecosystem);
  const artifactOrigins = ARTIFACT_ORIGINS[ecosystem];
  return firstPartyOriginPolicy({
    endpoint,
    namedOrOverride:
      options.endpoint !== undefined || registryEndpointIsOverride(ecosystem),
    ...(!(artifactOrigins === undefined) && { artifactOrigins }),
    extraOrigins: parseRegistryExtraOrigins(ecosystem),
  });
}

export function allowedOriginsFor(ecosystem: string): string[] {
  return firstPartyPolicy(ecosystem).allowedOrigins;
}

/**
 * Production first-party registry transport. Classify-and-pin; public CDNs
 * are allowlisted-not-pinned; an operator-named endpoint or `OPM_REGISTRY_*`
 * override is pinned and does not inherit hardcoded `ARTIFACT_ORIGINS`.
 */
export function firstPartyTransport(
  ecosystem: string,
  options: RegistryOptions = {},
): BoundedFetchTransport {
  const endpoint =
    options.endpoint !== undefined
      ? safeRegistryEndpoint(options.endpoint, ecosystem)
      : registryEndpoint(ecosystem);
  const artifactOrigins = ARTIFACT_ORIGINS[ecosystem];
  return createFirstPartyTransport({
    endpoint,
    namedOrOverride:
      options.endpoint !== undefined || registryEndpointIsOverride(ecosystem),
    ...(!(artifactOrigins === undefined) && { artifactOrigins }),
    extraOrigins: parseRegistryExtraOrigins(ecosystem),
    ...(options.fetch && { fetch: options.fetch }),
    ...(options.lookup && { lookup: options.lookup }),
  });
}

/** One DNS answer for host-fetch classification and pin. */
export type HostFetchLookup = HostLookup;

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
  /**
   * A provider already built for this ecosystem and source, to be used as is.
   * A provider remembers the registry documents it has read, so handing the same
   * one to each step of a resolve means a package's metadata is fetched once
   * rather than once per step.
   */
  provider?: CatalogProvider;
  fetch?: typeof fetch;
  /**
   * Host-fetch DNS seam. Production resolves with `dns.lookup({ all: true })`.
   * Tests inject answers so a hostname that rebinds to a private address is
   * refused without touching the network.
   */
  lookup?: HostFetchLookup;
  now?: () => string;
  /**
   * Project plugin bindings keyed by manifest id. Host-fetch looks up
   * `provider.providerId`. Absent on ephemeral runs.
   */
  pluginBindings?: Readonly<Record<string, PluginBinding>>;
  /**
   * What the project configured for this ecosystem's adapter. opm hands it
   * over untouched; the adapter decodes it and refuses what it does not know.
   */
  settings?: { readonly [key: string]: JsonValue };
  /**
   * What the lock already records about packages of this ecosystem, by
   * versionless PURL, so the adapter can notice a signer that changed.
   */
  priorAttestations?: { readonly [basePurl: string]: JsonValue };
}

/**
 * The signature evidence a lock kept, for the adapter that produced it.
 *
 * Keyed by versionless PURL. When one package appears more than once (two
 * aliases at two versions) the most recently signed record wins: that is the
 * signer the project last accepted.
 */
export function priorAttestationsFromLock(
  lock: Pick<OpmLockfile, 'packages'> | undefined,
  ecosystem: string,
): { readonly [basePurl: string]: JsonValue } | undefined {
  if (lock === undefined) return undefined;
  const newest = new Map<string, { signedAt: number; record: JsonValue }>();
  for (const pkg of Object.values(lock.packages)) {
    if (pkg.ecosystem !== ecosystem || pkg.attestation === undefined) continue;
    const key = stripPurlVersion(pkg.purl);
    const signedAt = Date.parse(pkg.attestation.signedAt);
    const held = newest.get(key);
    if (held === undefined || signedAt > held.signedAt)
      newest.set(key, { signedAt, record: pkg.attestation.record });
  }
  if (newest.size === 0) return undefined;
  return Object.fromEntries(
    [...newest].map(([key, { record }]) => [key, record]),
  );
}

/** Bind a project registry selection to the endpoint the adapter will use. */
export function registryOptionsForEcosystem(
  ecosystem: string,
  manifest: Pick<OpmManifest, 'registries' | 'plugins' | 'adapterSettings'>,
  requested: RegistryOptions = {},
  previousLock?: Pick<OpmLockfile, 'packages'>,
): RegistryOptions {
  const prior =
    requested.priorAttestations === undefined
      ? priorAttestationsFromLock(previousLock, ecosystem)
      : undefined;
  const projectSettings = manifest.adapterSettings?.[ecosystem];
  const withBindings: RegistryOptions = {
    ...(requested.pluginBindings !== undefined || manifest.plugins === undefined
      ? requested
      : { ...requested, pluginBindings: manifest.plugins }),
    // The committed manifest is where trust anchors come from. A caller that
    // passes its own settings (a test, a host) replaces them wholesale.
    ...(requested.settings === undefined &&
      projectSettings !== undefined && { settings: projectSettings }),
    ...(prior !== undefined && { priorAttestations: prior }),
  };
  if (withBindings.endpoint !== undefined)
    return {
      ...withBindings,
      endpoint: safeRegistryEndpoint(withBindings.endpoint, ecosystem),
    };
  const sourceId = sourceForEcosystem(
    ecosystem,
    manifest,
    withBindings.sourceId,
  );
  if (sourceId === undefined) return withBindings;
  const source = manifest.registries?.[sourceId];
  if (source === undefined) return withBindings;
  const { sourceId: _sourceId, ...options } = withBindings;
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

/**
 * The endpoint and transport a provider for `ecosystem` is built on: the
 * caller's, else the first-party one for the endpoint in force. A named source
 * with no endpoint of its own has neither, and the adapter supplies them.
 */
function transportFor(
  ecosystem: string,
  options: RegistryOptions,
): { endpoint: string | undefined; transport: HttpTransport | undefined } {
  const named = options.sourceId !== undefined;
  const endpoint =
    options.endpoint ??
    (named || DEFAULT_REGISTRY_ENDPOINTS[ecosystem] === undefined
      ? undefined
      : registryEndpoint(ecosystem));
  if (endpoint !== undefined) safeRegistryEndpoint(endpoint, ecosystem);
  const transport =
    options.transport ??
    (endpoint ? firstPartyTransport(ecosystem, options) : undefined);
  return { endpoint, transport };
}

/** Fail closed when the registry definition omits a required resource. */
export async function providerForWithDiscovery(
  ecosystem: string,
  options: RegistryOptions = {},
  requiredResources: readonly string[] = ['prex.registry.package-metadata/1'],
): Promise<CatalogProvider> {
  assertOnline(ecosystem, options.offline);
  if (options.provider !== undefined) return options.provider;
  const registry = requireAdapterRegistry();
  // A named source owns its own endpoint and origin allowlist; applying the
  // ecosystem's would point a mirror at npmjs.org, or refuse the mirror's own
  // origin as unsafe.
  const { endpoint, transport } = transportFor(ecosystem, options);
  try {
    return await registry.catalogFor(
      ecosystem,
      {
        ...(options.offline !== undefined && { offline: options.offline }),
        ...(!(options.sourceId === undefined) && {
          sourceId: options.sourceId,
        }),
        ...(!(endpoint === undefined) && { endpoint }),
        ...(!(transport === undefined) && { transport }),
        ...(options.fetch && { fetch: options.fetch }),
        ...(options.lookup && { lookup: options.lookup }),
        ...(options.now && { now: options.now }),
        ...(!(options.settings === undefined) && {
          settings: options.settings,
        }),
        ...(!(options.priorAttestations === undefined) && {
          priorAttestations: options.priorAttestations,
        }),
      },
      requiredResources,
    );
  } catch (error) {
    mapHostError(error);
  }
}

/** What a resolve asks of a registry, in one provider. */
const POOLED_RESOURCES = [
  'prex.registry.package-metadata/1',
  'prex.registry.enumerate-versions/1',
  'prex.registry.artifact/1',
] as const;

/**
 * The providers one resolve uses, built on first use and kept.
 *
 * A provider caches the documents it reads, but the adapter host builds a new
 * one on every request for it. Walking a closure asked for a provider per
 * queue item and per step, so a package referenced from ten places had its
 * packument fetched ten times: 165 requests for 42 distinct documents when
 * resolving vitest, `vite` alone seven times at 2.3 MB. One pool per resolve
 * brings that to one fetch per package, and the artifact step reuses the same
 * documents instead of asking again.
 */
function etagOf(response: HttpResponse): string | undefined {
  for (const [name, value] of Object.entries(response.headers))
    if (name.toLowerCase() === 'etag') return value;
  return undefined;
}

/**
 * Answers a repeated read of the same registry document from memory, and
 * bounds how many requests are in flight.
 *
 * A provider revalidates a document it already holds on every use, which for a
 * resolve is a round trip per queue item per step for documents that cannot
 * usefully change within it, and a resolve that read one package's metadata in
 * two places could see two different versions of it. This makes one resolve
 * read each document once: a request that carries the `etag` it was already
 * given is answered `304`, one that carries none gets the stored `200`, and a
 * request for a document already being fetched waits for that fetch rather
 * than starting another.
 *
 * Only small, repeatable reads are kept: a GET, bounded to a few MiB, that is
 * not an artifact download. Artifact bytes pass through and are not held. Every
 * request, kept or not, takes one of a fixed number of slots, so a walk that
 * reads ahead cannot open a connection per package.
 */
export class MemoizingTransport implements HttpTransport {
  static readonly ENTRY_LIMIT = 8 * 1024 * 1024;
  static readonly TOTAL_LIMIT = 128 * 1024 * 1024;
  static readonly CONCURRENCY = 12;
  readonly #kept = new Map<string, Promise<HttpResponse>>();
  readonly #waiting: (() => void)[] = [];
  #bytes = 0;
  #active = 0;

  constructor(private readonly inner: HttpTransport) {}

  async request(request: HttpRequest): Promise<HttpResponse> {
    if (!MemoizingTransport.repeatable(request)) return this.slot(request);
    const key = `${request.url}\n${request.headers?.accept ?? ''}`;
    const existing = this.#kept.get(key);
    if (existing === undefined) {
      const fetched = this.slot(request).then(
        (response) => {
          if (
            response.status === 200 &&
            response.body.byteLength <= MemoizingTransport.ENTRY_LIMIT &&
            this.#bytes + response.body.byteLength <=
              MemoizingTransport.TOTAL_LIMIT
          )
            this.#bytes += response.body.byteLength;
          else this.#kept.delete(key);
          return response;
        },
        (error: unknown) => {
          this.#kept.delete(key);
          throw error;
        },
      );
      this.#kept.set(key, fetched);
      return fetched;
    }
    const kept = await existing;
    const validator = request.headers?.['if-none-match'];
    return validator !== undefined && validator === etagOf(kept)
      ? {
          status: 304,
          headers: { etag: validator },
          body: new Uint8Array(),
          url: kept.url,
        }
      : kept;
  }

  /** Run `request` in one of the fixed number of slots. */
  private async slot(request: HttpRequest): Promise<HttpResponse> {
    if (this.#active < MemoizingTransport.CONCURRENCY) this.#active += 1;
    else await new Promise<void>((resolve) => this.#waiting.push(resolve));
    try {
      return await this.inner.request(request);
    } finally {
      // Hand the slot straight to the next in line; free it if none is.
      const next = this.#waiting.shift();
      if (next === undefined) this.#active -= 1;
      else next();
    }
  }

  private static repeatable(request: HttpRequest): boolean {
    return (
      (request.method === undefined || request.method === 'GET') &&
      request.headers?.accept !== 'application/octet-stream' &&
      (request.maximumBytes === undefined ||
        request.maximumBytes <= MemoizingTransport.ENTRY_LIMIT)
    );
  }
}

export class ProviderPool {
  readonly #providers = new Map<string, Promise<CatalogProvider>>();

  constructor(
    private readonly optionsFor: (ecosystem: string) => RegistryOptions,
  ) {}

  /** The options a step for `ecosystem` is made with, provider included. */
  async optionsWithProvider(ecosystem: string): Promise<RegistryOptions> {
    return {
      ...this.optionsFor(ecosystem),
      provider: await this.provider(ecosystem),
    };
  }

  provider(ecosystem: string): Promise<CatalogProvider> {
    let provider = this.#providers.get(ecosystem);
    if (provider === undefined) {
      const options = this.optionsFor(ecosystem);
      const { transport } = transportFor(ecosystem, options);
      provider = providerForWithDiscovery(
        ecosystem,
        transport === undefined
          ? options
          : { ...options, transport: new MemoizingTransport(transport) },
        POOLED_RESOURCES,
      );
      this.#providers.set(ecosystem, provider);
      // A failed build is not remembered: the next step tries again and reports
      // its own error rather than replaying this one.
      provider.catch(() => this.#providers.delete(ecosystem));
    }
    return provider;
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
    ...(!(options.sourceId === undefined) && { sourceId: options.sourceId }),
    ...(!(endpoint === undefined) && {
      endpoint: safeRegistryEndpoint(endpoint, ecosystem),
    }),
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
    ...(!(identity.namespace === undefined) && {
      namespace: identity.namespace,
    }),
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
  /** Signature evidence the provider verified for this release, if any. */
  attestation?: ProviderAttestation;
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
  const inspectedPurl = assertInspectedPurl(ecosystem, exactPurl, inspection);
  // Fetch the immutable identity established by inspection. In particular,
  // never resolve a mutable OCI tag a second time after it was pinned.
  const record = await provider.fetchArtifactRecord(inspectedPurl);
  const descriptor = readArtifactDescriptor(record.body, ecosystem, exactPurl);

  // Delegated providers answer metadata only (spec delegated-adapter.md
  // §Artifact bytes): the host fetches the bytes itself, bounded by the
  // published size and verified against the published digest. First-party
  // providers keep the bytes their own bounded transport already verified.
  if (hostFetchesArtifactBytes(provider)) {
    const fetched = await fetchDelegatedArtifactBytes({
      ecosystem,
      exactPurl: inspectedPurl,
      endpoint: record.endpoint,
      uri: descriptor.uri,
      size: descriptor.size,
      digest: descriptor.digest,
      providerId: provider.providerId,
      ...hostFetchCallOptions(options),
    });
    return {
      exactPurl: inspectedPurl,
      version: inspection.package.nativeVersion ?? '',
      digest: descriptor.digest,
      size: fetched.size,
      mediaType: descriptor.mediaType,
      uri: descriptor.uri,
      bytes: fetched.bytes,
      bins: inspection.executables ?? [],
      registryId,
      ...attestationOf(inspection),
    };
  }

  assertArtifactUriAllowed(descriptor.uri, ecosystem, exactPurl, options);

  return {
    exactPurl: inspectedPurl,
    version: inspection.package.nativeVersion ?? '',
    digest: descriptor.digest,
    size: descriptor.size ?? 0,
    mediaType: descriptor.mediaType,
    uri: descriptor.uri,
    bytes: record.rawBody,
    bins: inspection.executables ?? [],
    registryId,
    ...attestationOf(inspection),
  };
}

function attestationOf(
  inspection: ProviderInspection,
): { attestation: ProviderAttestation } | Record<string, never> {
  return inspection.attestation === undefined
    ? {}
    : { attestation: inspection.attestation };
}

/** The delegated provider marker: metadata authority, host-fetched bytes. */
function hostFetchesArtifactBytes(provider: CatalogProvider): boolean {
  return (
    provider.capabilities.extensions?.['openpacker/artifact-bytes'] ===
    'host-fetch'
  );
}

/**
 * The exact identity an inspection resolved, failing closed on a missing or
 * substituted one. Shared by every artifact resolution entry point.
 */
function assertInspectedPurl(
  ecosystem: string,
  exactPurl: string,
  inspection: ProviderInspection,
): string {
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
  return inspectedPurl;
}

/**
 * The artifact descriptor a metadata body publishes, failing closed when the
 * sha256 digest or the download location is absent: without them nothing
 * downstream can verify what it fetches.
 */
function readArtifactDescriptor(
  body: unknown,
  ecosystem: string,
  exactPurl: string,
) {
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  const descriptor = body as {
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
  return {
    digest: `${algorithm}:${value}`,
    ...(!(descriptor.size === undefined) && { size: descriptor.size }),
    mediaType: descriptor.mediaType ?? 'application/octet-stream',
    uri,
  };
}

/**
 * Inspect artifacts that are the same object `fetchArtifactRecord` returns.
 * Manifests, blobs, and other siblings share sha256+size+location shape but
 * are not the bytes the store verifies.
 */
const INSTALLABLE_ARCHIVE_ROLES: ReadonlySet<string> = new Set([
  'package-archive',
  'wheel',
  'sdist',
  'distribution',
]);

function assertRecordMatchesDescriptor(
  bytes: Uint8Array,
  descriptor: { digest: string; size?: number },
  exactPurl: string,
): void {
  if (descriptor.size !== undefined && bytes.byteLength !== descriptor.size)
    throw new OpmError(
      'SIZE_MISMATCH',
      `Registry size mismatch for ${exactPurl}: ` +
        `expected ${descriptor.size} bytes, got ${bytes.byteLength}`,
    );
  const actual = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  if (actual !== descriptor.digest)
    throw new OpmError(
      'DIGEST_MISMATCH',
      `Registry digest mismatch for ${exactPurl}: ` +
        `the inspect descriptor reported ${descriptor.digest}, the bytes hash to ${actual}`,
    );
}

/**
 * Fail closed when the published download location sits on an origin this
 * ecosystem's transports are not allowed to read. A registry that starts
 * handing back another host is the interesting failure, so it is refused by
 * name rather than left to the transport.
 */
function assertArtifactUriAllowed(
  uri: string,
  ecosystem: string,
  exactPurl: string,
  options: RegistryOptions,
): void {
  const uriOrigin = new URL(uri).origin;
  const allowed =
    options.endpoint !== undefined
      ? firstPartyPolicy(ecosystem, options).allowedOrigins
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
}

/**
 * An artifact resolution whose byte download is deferred whenever the
 * provider lets the digest be known without it.
 *
 * Registry metadata is always read fresh — an unpinned purl is a different
 * thing tomorrow — but artifact bytes are content-addressed, so a caller with
 * a digest-keyed cache (the ephemeral tool cache) can skip the download when
 * the resolved digest is already held, and call {@link fetchBytes} when it is
 * not.
 */
export interface DeferredRegistryArtifact {
  exactPurl: string;
  version: string;
  digest: string;
  size: number;
  mediaType: string;
  uri: string;
  bins: readonly ProviderExecutable[];
  registryId: string;
  /** Signature evidence the provider verified for this release, if any. */
  attestation?: ProviderAttestation;
  /**
   * The artifact bytes, when learning the digest already downloaded them: a
   * first-party fetch-artifact-record carries the bytes it hashes. Absent
   * whenever the download could be deferred — then {@link fetchBytes} is the
   * acquisition to run on a cache miss.
   */
  bytes?: Uint8Array;
  /**
   * Acquire the artifact bytes, verified against the published digest and
   * size exactly as {@link resolveRegistryArtifact} verifies them.
   */
  fetchBytes: () => Promise<Uint8Array>;
}

/**
 * Resolve an artifact's identity with the byte download deferred.
 *
 * Same metadata, same fail-closed checks as {@link resolveRegistryArtifact};
 * the only difference is when bytes move. A delegated provider's record is
 * cheap metadata and the host-side download is deferred wholesale. A
 * first-party inspection that publishes the full artifact descriptor (sha256
 * digest, size, location) defers the record call that is itself the download;
 * anything else falls back to reading the record, which carries the bytes.
 */
export async function resolveRegistryArtifactDeferred(
  ecosystem: string,
  exactPurl: string,
  options: RegistryOptions = {},
): Promise<DeferredRegistryArtifact> {
  const provider = await providerForWithDiscovery(ecosystem, options, [
    'prex.registry.package-metadata/1',
    'prex.registry.artifact/1',
  ]);
  const registryId = (await registryDefinitionFor(ecosystem, options))
    .registryId;
  const inspection = await provider.inspect(exactPurl);
  const inspectedPurl = assertInspectedPurl(ecosystem, exactPurl, inspection);
  const version = inspection.package.nativeVersion ?? '';
  const bins = inspection.executables ?? [];

  // Delegated providers answer metadata only (spec delegated-adapter.md
  // §Artifact bytes): the record is cheap, and the byte download is the
  // host's to make — deferred until the caller says the cache missed.
  if (hostFetchesArtifactBytes(provider)) {
    const record = await provider.fetchArtifactRecord(inspectedPurl);
    const descriptor = readArtifactDescriptor(
      record.body,
      ecosystem,
      exactPurl,
    );
    return {
      exactPurl: inspectedPurl,
      version,
      digest: descriptor.digest,
      size: descriptor.size ?? 0,
      mediaType: descriptor.mediaType,
      uri: descriptor.uri,
      bins,
      registryId,
      ...attestationOf(inspection),
      fetchBytes: async () =>
        (
          await fetchDelegatedArtifactBytes({
            ecosystem,
            exactPurl: inspectedPurl,
            endpoint: record.endpoint,
            uri: descriptor.uri,
            size: descriptor.size,
            digest: descriptor.digest,
            providerId: provider.providerId,
            ...hostFetchCallOptions(options),
          })
        ).bytes,
    };
  }

  // A first-party inspection that publishes the *installable archive*
  // (nativeRole package-archive / wheel / sdist / distribution) makes the
  // record call — the download — deferrable. Inspect artifacts that are a
  // different object than fetchArtifactRecord returns (OCI manifests vs the
  // layout tar) must not become the cache key: hashing the layout against the
  // manifest digest is a false DIGEST_MISMATCH and a first-party regression.
  const published = inspection.package.artifacts.find(
    (artifact) =>
      INSTALLABLE_ARCHIVE_ROLES.has(artifact.nativeRole) &&
      artifact.digest?.algorithm === 'sha256' &&
      typeof artifact.digest.value === 'string' &&
      artifact.digest.value.length > 0 &&
      Number.isFinite(artifact.size) &&
      artifact.size > 0 &&
      artifact.locations.some((location) => typeof location.uri === 'string'),
  );
  if (published !== undefined) {
    const descriptor = readArtifactDescriptor(published, ecosystem, exactPurl);
    assertArtifactUriAllowed(descriptor.uri, ecosystem, exactPurl, options);
    return {
      exactPurl: inspectedPurl,
      version,
      digest: descriptor.digest,
      size: descriptor.size ?? 0,
      mediaType: descriptor.mediaType,
      uri: descriptor.uri,
      bins,
      registryId,
      ...attestationOf(inspection),
      fetchBytes: async () => {
        const record = await provider.fetchArtifactRecord(inspectedPurl);
        assertRecordMatchesDescriptor(record.rawBody, descriptor, exactPurl);
        return record.rawBody;
      },
    };
  }

  // Otherwise the record call is the only way to learn the digest, and it
  // carries the bytes: resolve exactly as resolveRegistryArtifact does.
  const record = await provider.fetchArtifactRecord(inspectedPurl);
  const descriptor = readArtifactDescriptor(record.body, ecosystem, exactPurl);
  assertArtifactUriAllowed(descriptor.uri, ecosystem, exactPurl, options);
  return {
    exactPurl: inspectedPurl,
    version,
    digest: descriptor.digest,
    size: descriptor.size ?? 0,
    mediaType: descriptor.mediaType,
    uri: descriptor.uri,
    bytes: record.rawBody,
    bins,
    registryId,
    ...attestationOf(inspection),
    fetchBytes: async () => record.rawBody,
  };
}

/**
 * Host-side byte acquisition for a delegated provider (spec
 * delegated-adapter.md §Artifact bytes, ADR 0040).
 *
 * The plugin is the metadata authority, never a byte proxy: the host downloads
 * from a location on an origin in `{endpoint origin} ∪ pins` (env ∪ this
 * plugin's `artifact_origins`), over HTTPS without query or hash, bounded by
 * the published size, and verifies the sha256 digest before the bytes are
 * anyone's artifact. An operator bearer or extra header attaches only when the
 * hop origin is pinned and a per-origin env-var name is configured. Every gap
 * fails closed.
 */
function hostFetchCallOptions(options: RegistryOptions) {
  return {
    ...(!(options.fetch === undefined) && { fetch: options.fetch }),
    ...(!(options.lookup === undefined) && { lookup: options.lookup }),
    ...(!(options.pluginBindings === undefined) && {
      pluginBindings: options.pluginBindings,
    }),
  };
}

async function fetchDelegatedArtifactBytes(input: {
  ecosystem: string;
  exactPurl: string;
  endpoint: string;
  uri: string;
  size: number | undefined;
  digest: string;
  providerId?: string;
  pluginBindings?: Readonly<Record<string, PluginBinding>>;
  fetch?: typeof fetch;
  lookup?: HostFetchLookup;
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
      `The ${input.ecosystem} registry answered from an endpoint that is not a URL.`,
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
  if (
    location.protocol !== 'https:' ||
    location.username ||
    location.password ||
    location.search !== '' ||
    location.hash !== ''
  )
    throw new OpmError(
      'UNSAFE_PATH',
      `Refusing to fetch ${input.exactPurl} from ${redactUrl(location)}: ` +
        'artifact locations must be HTTPS and carry no credentials, query, or hash.',
    );
  const envPins = parseHostFetchPinnedOrigins(
    process.env.OPM_HOST_FETCH_ORIGINS,
  );
  const envTokenNames = parseParallelTokenEnvNames(
    process.env.OPM_HOST_FETCH_TOKEN_ENVS,
    envPins,
  );
  const envExtraHeaders = parseParallelExtraHeaders(
    process.env.OPM_HOST_FETCH_HEADER_NAMES,
    process.env.OPM_HOST_FETCH_HEADER_ENVS,
    envPins,
  );
  const binding =
    input.providerId === undefined
      ? undefined
      : input.pluginBindings?.[input.providerId];
  const projectPins = binding?.artifactOrigins ?? [];
  const pins = [...new Set([...envPins, ...projectPins])];
  if (hostFetchRequiresPin() && !pins.includes(location.origin))
    throw new OpmError(
      'UNSAFE_PATH',
      `OPM_HOST_FETCH_REQUIRE_PIN refuses ${redactUrl(location)}: the hop origin is not operator-pinned.`,
    );
  const allowlist = [endpointOrigin, ...pins];
  if (!allowlist.includes(location.origin))
    throw new OpmError(
      'UNSAFE_PATH',
      `${input.exactPurl} points at ${location.origin}, which is not an allowed ` +
        `origin for this host-fetch (${[...new Set(allowlist)].join(', ')}).`,
    );
  const tokenEnvNames = mergeTokenEnvNames({
    envPins,
    envTokenNames,
    projectPins,
    projectTokenNames: binding?.artifactOriginTokenEnvs,
  });
  const extraHeaders = mergeExtraHeaders({
    envPins,
    envHeaderNames: envExtraHeaders?.names,
    envHeaderEnvs: envExtraHeaders?.envs,
    projectPins,
    projectHeaderNames: binding?.artifactOriginExtraHeaderNames,
    projectHeaderEnvs: binding?.artifactOriginExtraHeaderEnvs,
  });
  let transport: BoundedFetchTransport;
  try {
    transport = new BoundedFetchTransport({
      allowedOrigins: allowlist,
      destinationPolicy: 'classify-and-pin',
      pinnedOrigins: [...pins],
      pinnedTokenEnvNames: tokenEnvNames,
      pinnedExtraHeaders: extraHeaders,
      maximumBytes: size,
      ...(input.fetch && { fetch: input.fetch }),
      ...(input.lookup && { lookup: input.lookup }),
    });
  } catch (error) {
    if (
      error instanceof ProviderError &&
      error.code === 'INVALID_PROVIDER_ENDPOINT'
    )
      throw new OpmError('INVALID_PROVIDER_ENDPOINT', error.message);
    throw error;
  }
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
    if (
      error instanceof ProviderError &&
      error.code === 'INVALID_PROVIDER_ENDPOINT'
    )
      throw new OpmError('UNSAFE_PATH', error.message);
    if (error instanceof ProviderError && error.code === 'UNRESOLVABLE')
      throw new OpmError('UNRESOLVABLE', error.message);
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

const TOKEN_ENV_NAME = /^[A-Z_][A-Z0-9_]*$/u;

function parseParallelTokenEnvNames(
  raw: string | undefined,
  origins: readonly string[],
): string[] | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const names = raw.split(',').map((part) => part.trim());
  if (names.length !== origins.length)
    throw new OpmError(
      'INVALID_PROVIDER_ENDPOINT',
      `OPM_HOST_FETCH_TOKEN_ENVS has ${names.length} entries but OPM_HOST_FETCH_ORIGINS has ${origins.length}`,
    );
  for (const name of names) {
    if (name === '') continue;
    if (!TOKEN_ENV_NAME.test(name))
      throw new OpmError(
        'INVALID_PROVIDER_ENDPOINT',
        'OPM_HOST_FETCH_TOKEN_ENVS entry is not a valid environment variable name',
      );
  }
  return names;
}

function tokenEnvNameFor(
  origin: string,
  input: {
    projectPins: readonly string[];
    projectTokenNames: readonly string[] | undefined;
    envPins: readonly string[];
    envTokenNames: readonly string[] | undefined;
  },
): string | undefined {
  if (input.projectTokenNames !== undefined) {
    const index = input.projectPins.indexOf(origin);
    if (index !== -1) return input.projectTokenNames[index];
  }
  if (input.envTokenNames !== undefined) {
    const index = input.envPins.indexOf(origin);
    if (index !== -1) return input.envTokenNames[index];
  }
  return undefined;
}

function mergeTokenEnvNames(input: {
  envPins: readonly string[];
  envTokenNames: readonly string[] | undefined;
  projectPins: readonly string[];
  projectTokenNames: readonly string[] | undefined;
}): Map<string, string> {
  const pins = [...new Set([...input.envPins, ...input.projectPins])];
  const names = new Map<string, string>();
  for (const origin of pins) {
    const name = tokenEnvNameFor(origin, input);
    if (name !== undefined && name !== '') names.set(origin, name);
  }
  return names;
}

/** RFC 7230 header-field token. */
const RFC7230_TOKEN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/u;

const FORBIDDEN_EXTRA_HEADER_NAMES = new Set([
  'authorization',
  'cookie',
  'cookie2',
  'proxy-authorization',
  'host',
  'connection',
  'transfer-encoding',
  'content-length',
  'te',
  'upgrade',
  'trailer',
  'keep-alive',
  'content-type',
  'accept-encoding',
]);

function parseParallelExtraHeaders(
  namesRaw: string | undefined,
  envsRaw: string | undefined,
  origins: readonly string[],
): { names: string[]; envs: string[] } | undefined {
  const namesPresent = namesRaw !== undefined && namesRaw.trim() !== '';
  const envsPresent = envsRaw !== undefined && envsRaw.trim() !== '';
  if (!namesPresent && !envsPresent) return undefined;
  if (!namesPresent || !envsPresent)
    throw new OpmError(
      'INVALID_PROVIDER_ENDPOINT',
      'OPM_HOST_FETCH_HEADER_NAMES and OPM_HOST_FETCH_HEADER_ENVS must both be present',
    );
  const names = namesRaw.split(',').map((part) => part.trim());
  const envs = envsRaw.split(',').map((part) => part.trim());
  if (names.length !== origins.length)
    throw new OpmError(
      'INVALID_PROVIDER_ENDPOINT',
      `OPM_HOST_FETCH_HEADER_NAMES has ${names.length} entries but OPM_HOST_FETCH_ORIGINS has ${origins.length}`,
    );
  if (envs.length !== origins.length)
    throw new OpmError(
      'INVALID_PROVIDER_ENDPOINT',
      `OPM_HOST_FETCH_HEADER_ENVS has ${envs.length} entries but OPM_HOST_FETCH_ORIGINS has ${origins.length}`,
    );
  for (let i = 0; i < names.length; i += 1) {
    const name = names[i]!;
    const envName = envs[i]!;
    if (name === '') {
      if (envName !== '' && !TOKEN_ENV_NAME.test(envName))
        throw new OpmError(
          'INVALID_PROVIDER_ENDPOINT',
          'OPM_HOST_FETCH_HEADER_ENVS entry is not a valid environment variable name',
        );
      continue;
    }
    if (
      !RFC7230_TOKEN.test(name) ||
      FORBIDDEN_EXTRA_HEADER_NAMES.has(name.toLowerCase())
    )
      throw new OpmError(
        'INVALID_PROVIDER_ENDPOINT',
        'OPM_HOST_FETCH_HEADER_NAMES entry is not a valid extra header name',
      );
    if (!TOKEN_ENV_NAME.test(envName))
      throw new OpmError(
        'INVALID_PROVIDER_ENDPOINT',
        'OPM_HOST_FETCH_HEADER_ENVS entry is not a valid environment variable name',
      );
  }
  return { names, envs };
}

function extraHeaderFor(
  origin: string,
  input: {
    projectPins: readonly string[];
    projectHeaderNames: readonly string[] | undefined;
    projectHeaderEnvs: readonly string[] | undefined;
    envPins: readonly string[];
    envHeaderNames: readonly string[] | undefined;
    envHeaderEnvs: readonly string[] | undefined;
  },
): { name: string; envName: string } | undefined {
  if (
    input.projectHeaderNames !== undefined &&
    input.projectHeaderEnvs !== undefined
  ) {
    const index = input.projectPins.indexOf(origin);
    if (index !== -1)
      return {
        name: input.projectHeaderNames[index] ?? '',
        envName: input.projectHeaderEnvs[index] ?? '',
      };
  }
  if (input.envHeaderNames !== undefined && input.envHeaderEnvs !== undefined) {
    const index = input.envPins.indexOf(origin);
    if (index !== -1)
      return {
        name: input.envHeaderNames[index] ?? '',
        envName: input.envHeaderEnvs[index] ?? '',
      };
  }
  return undefined;
}

function mergeExtraHeaders(input: {
  envPins: readonly string[];
  envHeaderNames: readonly string[] | undefined;
  envHeaderEnvs: readonly string[] | undefined;
  projectPins: readonly string[];
  projectHeaderNames: readonly string[] | undefined;
  projectHeaderEnvs: readonly string[] | undefined;
}): Map<string, { name: string; envName: string }> {
  const pins = [...new Set([...input.envPins, ...input.projectPins])];
  const headers = new Map<string, { name: string; envName: string }>();
  for (const origin of pins) {
    const header = extraHeaderFor(origin, input);
    if (header !== undefined && header.name !== '') headers.set(origin, header);
  }
  return headers;
}

function hostFetchRequiresPin(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.OPM_HOST_FETCH_REQUIRE_PIN?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function parseHostFetchPinnedOrigins(raw: string | undefined): string[] {
  const trimmed = raw?.trim() ?? '';
  if (trimmed === '') return [];
  const origins: string[] = [];
  const seen = new Set<string>();
  for (const part of trimmed.split(',')) {
    const value = part.trim();
    if (value === '') continue;
    let origin: string;
    try {
      origin = normalizePinnedOrigin(value);
    } catch (error) {
      if (
        error instanceof ProviderError &&
        error.code === 'INVALID_PROVIDER_ENDPOINT'
      )
        throw new OpmError('INVALID_PROVIDER_ENDPOINT', error.message);
      throw error;
    }
    if (seen.has(origin))
      throw new OpmError(
        'INVALID_PROVIDER_ENDPOINT',
        `OPM_HOST_FETCH_ORIGINS lists duplicate origin ${origin}`,
      );
    seen.add(origin);
    origins.push(origin);
  }
  return origins;
}
