import {
  BoundedFetchTransport,
  type CatalogProvider,
  type HttpTransport,
} from '@openpacker/adapter-core';
import { CargoSparseProvider } from '@openpacker/adapter-cargo';
import { GolangProxyProvider } from '@openpacker/adapter-golang';
import { MavenRepositoryProvider } from '@openpacker/adapter-maven';
import { NpmRegistryProvider } from '@openpacker/adapter-npm';
import { NugetV3Provider } from '@openpacker/adapter-nuget';
import { PypiJsonProvider } from '@openpacker/adapter-pypi';
import { OpmError } from './types.js';

/**
 * Resolving a PURL against the ecosystem's real registry.
 *
 * The providers already existed and already spoke to live registries; nothing
 * in `opm` called them, so `opm add pkg:npm/lodash@4.17.21` failed as
 * UNRESOLVABLE unless you handed it a file. This is the wiring.
 *
 * Two properties are preserved rather than relaxed. `--offline` still refuses
 * every network read, so an offline build cannot silently start depending on a
 * registry being reachable. And every request goes through
 * `BoundedFetchTransport` against an explicit origin allowlist, so a redirect
 * or a hostile catalog entry cannot move the fetch to another host.
 */

/**
 * Where each ecosystem is read from by default.
 *
 * Overridable per ecosystem with `OPM_REGISTRY_<ECOSYSTEM>` — a private npm
 * registry, an internal Artifactory, a pull-through cache. An override is also
 * added to the allowlist, because naming a registry is what authorizing it
 * means; nothing else is.
 */
export const DEFAULT_REGISTRY_ENDPOINTS: Readonly<Record<string, string>> = {
  npm: 'https://registry.npmjs.org',
  cargo: 'https://index.crates.io',
  pypi: 'https://pypi.org/pypi',
  nuget: 'https://api.nuget.org/v3/index.json',
  maven: 'https://repo1.maven.org/maven2',
  golang: 'https://proxy.golang.org',
};

/** Ecosystems `opm` can resolve from a registry. */
export const REGISTRY_ECOSYSTEMS = Object.freeze(
  Object.keys(DEFAULT_REGISTRY_ENDPOINTS),
);

/**
 * Hosts an ecosystem serves artifacts from, beyond its metadata endpoint.
 *
 * Registries routinely answer metadata on one host and hand back download URLs
 * on another. These are listed rather than discovered, so a compromised
 * metadata response cannot introduce a new download host.
 */
const ARTIFACT_ORIGINS: Readonly<Record<string, readonly string[]>> = {
  npm: ['https://registry.npmjs.org'],
  cargo: ['https://static.crates.io', 'https://crates.io'],
  pypi: ['https://files.pythonhosted.org', 'https://pypi.org'],
  nuget: ['https://api.nuget.org', 'https://globalcdn.nuget.org'],
  maven: ['https://repo1.maven.org', 'https://repo.maven.apache.org'],
  golang: ['https://proxy.golang.org'],
};

export function registryEndpoint(ecosystem: string): string {
  const override =
    process.env[`OPM_REGISTRY_${ecosystem.toUpperCase()}`]?.trim();
  const endpoint = override || DEFAULT_REGISTRY_ENDPOINTS[ecosystem];
  if (!endpoint)
    throw new OpmError(
      'UNSUPPORTED_ECOSYSTEM',
      `No registry is configured for "${ecosystem}". Supported: ${REGISTRY_ECOSYSTEMS.join(', ')}.`,
    );
  return endpoint;
}

/** Origins a given ecosystem is permitted to contact. */
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
  /** Injected by tests so nothing reaches a real registry unintentionally. */
  transport?: HttpTransport;
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

/**
 * A provider for one ecosystem, bound to its allowlist.
 *
 * Built per call rather than cached: the allowlist is derived from the
 * endpoint, and a long-lived process that changed `OPM_REGISTRY_*` between
 * calls should not keep talking to the old host.
 */
export function providerFor(
  ecosystem: string,
  options: RegistryOptions = {},
): CatalogProvider {
  assertOnline(ecosystem, options.offline);
  const endpoint = registryEndpoint(ecosystem);
  const transport =
    options.transport ??
    new BoundedFetchTransport({ allowedOrigins: allowedOriginsFor(ecosystem) });
  const clock = { now: options.now ?? (() => new Date().toISOString()) };

  switch (ecosystem) {
    case 'npm':
      return new NpmRegistryProvider(transport, clock, endpoint);
    case 'cargo':
      return new CargoSparseProvider(transport, clock, endpoint);
    case 'pypi':
      return new PypiJsonProvider(transport, clock, endpoint);
    case 'nuget':
      return new NugetV3Provider(transport, clock, endpoint);
    case 'maven':
      return new MavenRepositoryProvider(transport, clock, endpoint);
    case 'golang':
      return new GolangProxyProvider(transport, clock, endpoint);
    default:
      throw new OpmError(
        'UNSUPPORTED_ECOSYSTEM',
        `No registry provider for "${ecosystem}". Supported: ${REGISTRY_ECOSYSTEMS.join(', ')}.`,
      );
  }
}

/** Candidate identities for a free-text query or a partial PURL. */
export async function searchRegistry(
  ecosystem: string,
  query: string,
  options: RegistryOptions = {},
): Promise<{ canonicalPurl: string; name: string; namespace?: string }[]> {
  const provider = providerFor(ecosystem, options);
  const found = await provider.identify(query);
  return found.map((identity) => ({
    canonicalPurl: identity.canonicalPurl,
    name: identity.name,
    ...(identity.namespace === undefined
      ? {}
      : { namespace: identity.namespace }),
  }));
}

/** Every published version of a package, oldest first. */
export async function listRegistryVersions(
  ecosystem: string,
  basePurl: string,
  options: RegistryOptions = {},
): Promise<readonly string[]> {
  const provider = providerFor(ecosystem, options);
  return provider.enumerate(basePurl);
}

export interface RegistryArtifact {
  exactPurl: string;
  version: string;
  digest: string;
  size: number;
  mediaType: string;
  uri: string;
  /**
   * The artifact bytes, as fetched and checked by the provider.
   *
   * Carried rather than re-fetched. The provider already validated them
   * against the registry's own integrity claim — npm's SRI, NuGet's package
   * hash — and derived `digest` from these exact bytes. Downloading a second
   * time would cost another transfer and check the new bytes against a digest
   * taken from the old ones, which is a weaker statement, not a stronger one.
   */
  bytes: Uint8Array;
}

/**
 * The downloadable artifact for an exact PURL: what it is, how big, what it
 * must hash to, and where to get it.
 *
 * The digest comes from the registry's own metadata, which is what makes the
 * download checkable — `opm` verifies the bytes against it before anything is
 * written to the store, exactly as the catalog path already did.
 */
export async function resolveRegistryArtifact(
  ecosystem: string,
  exactPurl: string,
  options: RegistryOptions = {},
): Promise<RegistryArtifact> {
  const provider = providerFor(ecosystem, options);
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
  // The transport allowlist covers the request, but failing here names the
  // problem instead of surfacing it as a generic transport rejection.
  const allowed = allowedOriginsFor(ecosystem);
  if (!allowed.includes(new URL(uri).origin))
    throw new OpmError(
      'UNSAFE_PATH',
      `${exactPurl} points at ${new URL(uri).origin}, which is not an allowed ` +
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
