import {
  ProviderError,
  createPinnedFetch,
  formatPurl,
  packageNodeId,
  parsePurl,
  type CatalogProvider,
  type HostLookup,
  type ProviderCapabilities,
  type ProviderInspection,
  type ProviderRecord,
} from '@openpacker/adapter-core';
import type {
  JsonValue,
  PackageIdentity,
  PackageInstance,
  SourceSnapshot,
} from '@openpacker/contracts';
import { sha256 } from '@openpacker/canonical';
import {
  BearerTokenAuthentication,
  DOCKER_MEDIA_TYPES,
  OCI_MEDIA_TYPES,
  isIndexMediaType,
  isImageMediaType,
  OciRegistryClient,
  type OciDescriptor,
  type OciIndex,
  type OciManifest,
  type RegistryAuthentication,
} from './index.js';
import { packUstarAsync, type AsyncTarFile } from './tar.js';

/**
 * OCI registries as a PREX catalog.
 *
 * Container registries are the one ecosystem where identity is already what
 * PREX wants it to be: a manifest digest names exact bytes, and a tag is only
 * a pointer at one. That maps cleanly — a tag is the mutable name you browse
 * by, and the digest is what gets locked.
 *
 * PURLs follow the purl specification for `oci`: the name is the final path
 * segment, `repository_url` carries registry and repository, and the version
 * is the manifest digest. A bare `pkg:oci/library/alpine` is also accepted and
 * read as a Docker Hub path, because requiring the qualifier for the common
 * case makes the CLI unusable by hand.
 */

const DEFAULT_REGISTRY = 'registry-1.docker.io';
const DEFAULT_ALLOWED_REGISTRY_ORIGINS = [
  `https://${DEFAULT_REGISTRY}`,
  'https://ghcr.io',
] as const;

export const OCI_MATERIALIZATION_LIMITS = Object.freeze({
  maximumLayers: 256,
  maximumLayoutBytes: 512 * 1024 * 1024,
});

function exactRegistryOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new ProviderError(
      'INVALID_PROVIDER_ENDPOINT',
      `OCI registry authority must be an exact HTTPS origin: ${value}`,
    );
  return url.origin;
}

export interface OciRegistryProviderOptions {
  fetch?: typeof fetch;
  lookup?: HostLookup;
  /**
   * Exact registry origins an untrusted PURL may select. Docker Hub and
   * ghcr.io by default, allowlisted-not-pinned.
   */
  allowedRegistryOrigins?: readonly string[];
  /**
   * Origins that may resolve to private addresses. Never inferred from
   * allowedRegistryOrigins. Empty by default.
   */
  pinnedRegistryOrigins?: readonly string[];
  /** Authentication is usable only for this independently configured origin. */
  authentication?: {
    registryOrigin: string;
    handler: RegistryAuthentication;
  };
  now?: () => string;
}

export interface OciRepositoryReference {
  registry: string;
  repository: string;
  name: string;
  tag?: string;
  digest?: string;
}

/** Where `docker pull alpine` actually goes. */
function normalizeDockerRepository(repository: string): string {
  return repository.includes('/') ? repository : `library/${repository}`;
}

/**
 * Resolve a PURL to a registry and repository.
 *
 * Registry hosts are validated rather than trusted: this value ends up as the
 * origin of an outbound request, so a malformed or credential-bearing
 * authority must not reach the client.
 */
export function parseOciPurl(value: string): OciRepositoryReference {
  const parsed = parsePurl(value);
  if (parsed.type !== 'oci')
    throw new ProviderError(
      'INVALID_PURL',
      `Not an OCI PURL: ${value} (expected pkg:oci/...)`,
    );

  const repositoryUrl = parsed.qualifiers.repository_url;
  let registry = DEFAULT_REGISTRY;
  let repository: string;

  if (repositoryUrl !== undefined && repositoryUrl !== '') {
    // Accept "host/path" and "https://host/path"; reject anything carrying
    // credentials, a port-less garbage authority, or a query.
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//iu.test(repositoryUrl)
      ? repositoryUrl
      : `https://${repositoryUrl}`;
    let url: URL;
    try {
      url = new URL(withScheme);
    } catch {
      throw new ProviderError(
        'INVALID_PURL',
        `repository_url is not a valid registry reference: ${repositoryUrl}`,
      );
    }
    if (url.protocol !== 'https:')
      throw new ProviderError(
        'INVALID_PURL',
        `OCI registries must be HTTPS: ${repositoryUrl}`,
      );
    if (url.username || url.password)
      throw new ProviderError(
        'INVALID_PURL',
        'repository_url must not carry credentials',
      );
    if (url.search || url.hash)
      throw new ProviderError(
        'INVALID_PURL',
        'repository_url must not carry a query or fragment',
      );
    registry = url.host;
    repository = url.pathname.replace(/^\/+|\/+$/gu, '');
  } else {
    repository = [parsed.namespace, parsed.name]
      .filter((part): part is string => part !== undefined && part !== '')
      .join('/');
  }

  if (registry === 'docker.io' || registry === 'index.docker.io')
    registry = DEFAULT_REGISTRY;
  if (registry === DEFAULT_REGISTRY)
    repository = normalizeDockerRepository(repository);

  if (!/^[a-z0-9]+(?:(?:[._-]|\/)[a-z0-9]+)*$/u.test(repository))
    throw new ProviderError(
      'INVALID_PURL',
      `Not a valid OCI repository name: ${repository}`,
    );

  const tag = parsed.qualifiers.tag;
  if (tag !== undefined && !/^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/u.test(tag))
    throw new ProviderError('INVALID_PURL', `Not a valid OCI tag: ${tag}`);

  const digest = parsed.version;
  if (digest !== undefined && !/^sha256:[0-9a-f]{64}$/u.test(digest))
    throw new ProviderError(
      'INVALID_PURL',
      `An OCI version must be a manifest digest: ${digest}`,
    );

  return {
    registry,
    repository,
    name: repository.split('/').at(-1)!,
    ...(!(tag === undefined) && { tag }),
    ...(!(digest === undefined) && { digest }),
  };
}

/**
 * Build a PURL for a repository, optionally pinned.
 *
 * Written as explicit inclusion rather than "override with undefined": the
 * three cases — the repository itself, one tag of it, one digest of it — are
 * genuinely different things to name, and conflating them behind optional
 * overrides is how a mutable tag ends up somewhere a digest belongs.
 */
function purlFor(
  reference: OciRepositoryReference,
  pin:
    | { kind: 'repository' }
    | { kind: 'tag'; tag: string }
    | {
        kind: 'digest';
        digest: string;
      },
): string {
  return formatPurl({
    type: 'oci',
    name: reference.name,
    qualifiers: {
      repository_url: `${reference.registry}/${reference.repository}`,
      ...(pin.kind === 'tag' && { tag: pin.tag }),
    },
    ...(pin.kind === 'digest' && { version: pin.digest }),
  });
}

export class OciRegistryProvider implements CatalogProvider {
  readonly providerId = 'oci-registry';
  readonly capabilities: ProviderCapabilities = {
    operations: ['identify', 'enumerate', 'inspect', 'artifact'],
    purlTypes: ['oci'],
    qualifierSupport: 'partial',
    targetSpecificSemantics: true,
    offlineReplay: false,
    extensions: { 'openpacker.dev/oci': 'distribution-v2' },
  };

  constructor(private readonly options: OciRegistryProviderOptions = {}) {
    this.allowedRegistryOrigins = new Set(
      (options.allowedRegistryOrigins ?? DEFAULT_ALLOWED_REGISTRY_ORIGINS).map(
        exactRegistryOrigin,
      ),
    );
    if (this.allowedRegistryOrigins.size === 0)
      throw new ProviderError(
        'INVALID_PROVIDER_ENDPOINT',
        'OCI provider requires at least one allowed registry origin',
      );
    if (
      options.authentication &&
      !this.allowedRegistryOrigins.has(
        exactRegistryOrigin(options.authentication.registryOrigin),
      )
    )
      throw new ProviderError(
        'INVALID_PROVIDER_ENDPOINT',
        'OCI authentication origin must also be an allowed registry origin',
      );
    const fetchOrigins = [...this.allowedRegistryOrigins];
    for (const origin of this.allowedRegistryOrigins)
      fetchOrigins.push(
        ...(BearerTokenAuthentication.WELL_KNOWN_TOKEN_ORIGINS[origin] ?? []),
      );
    this.#fetch = createPinnedFetch({
      allowedOrigins: [...new Set(fetchOrigins)],
      pinnedOrigins: options.pinnedRegistryOrigins ?? [],
      ...(options.fetch && { fetch: options.fetch }),
      ...(options.lookup && { lookup: options.lookup }),
    });
  }

  private readonly allowedRegistryOrigins: ReadonlySet<string>;
  readonly #fetch: typeof fetch;

  #client(reference: OciRepositoryReference): OciRegistryClient {
    const registry = exactRegistryOrigin(`https://${reference.registry}`);
    if (!this.allowedRegistryOrigins.has(registry))
      throw new ProviderError(
        'INVALID_PROVIDER_ENDPOINT',
        `OCI registry origin is not operator-authorized: ${registry}`,
      );
    const configuredAuthentication = this.options.authentication;
    const authentication =
      configuredAuthentication &&
      exactRegistryOrigin(configuredAuthentication.registryOrigin) === registry
        ? configuredAuthentication.handler
        : new BearerTokenAuthentication({ fetch: this.#fetch });
    return new OciRegistryClient({
      registry,
      repository: reference.repository,
      fetch: this.#fetch,
      authentication,
    });
  }

  async identify(query: string): Promise<readonly PackageIdentity[]> {
    // Registries have no search API in the distribution specification, so this
    // canonicalizes a reference rather than pretending to discover one.
    const reference = parseOciPurl(
      query.startsWith('pkg:') ? query : `pkg:oci/${query}`,
    );
    return [
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      {
        canonicalPurl: purlFor(reference, { kind: 'repository' }),
        purlType: 'oci',
        name: reference.name,
        qualifiers: {
          repository_url: `${reference.registry}/${reference.repository}`,
        },
        nativeCoordinates: [
          {
            ecosystem: 'oci',
            coordinate: `${reference.registry}/${reference.repository}`,
          },
        ],
        aliases: [],
        sourceRefs: [],
        publisherRefs: [],
        externalRefs: [],
      } as PackageIdentity,
    ];
  }

  async enumerate(
    basePurl: string,
    signal?: AbortSignal,
  ): Promise<readonly string[]> {
    const reference = parseOciPurl(basePurl);
    const tags = await this.#client(reference).listTags(
      signal ? { signal } : {},
    );
    // Registries return tags lexically; that is the order they publish and it
    // is not a version order, so it is passed through rather than sorted into
    // a semantic one this provider cannot justify.
    return tags.map((tag) => purlFor(reference, { kind: 'tag', tag }));
  }

  async inspect(
    exactPurl: string,
    signal?: AbortSignal,
  ): Promise<ProviderInspection> {
    const reference = parseOciPurl(exactPurl);
    const target = reference.digest ?? reference.tag;
    if (target === undefined)
      throw new ProviderError(
        'INVALID_PURL',
        `${exactPurl} names neither a tag nor a digest`,
      );

    const client = this.#client(reference);
    const pulled = await client.pullManifest(target, undefined, signal);
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const manifest = pulled.manifest as OciManifest;
    const digest = pulled.descriptor.digest;

    const canonicalPurl = purlFor(reference, { kind: 'repository' });
    const resolved = purlFor(reference, { kind: 'digest', digest });
    const nodeId = await packageNodeId({
      exactPurl: resolved,
      qualifiers: parsePurl(resolved).qualifiers,
      nativeSemanticsVersion: 'oci-v1',
    });

    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const instance = {
      nodeId,
      identity: {
        canonicalPurl,
        exactPurl: resolved,
        purlType: 'oci',
        name: reference.name,
        qualifiers: parsePurl(resolved).qualifiers,
        nativeCoordinates: [
          {
            ecosystem: 'oci',
            coordinate: `${reference.registry}/${reference.repository}`,
            version: digest,
          },
        ],
        aliases: [],
        sourceRefs: [],
        publisherRefs: [],
        externalRefs: [],
      },
      // The digest is the version. A tag is a pointer and must never become
      // identity — invariant 1.
      nativeVersion: digest,
      normalizedVersion: digest,
      versionSortKey: digest,
      requirements: [],
      capabilities: [],
      conflicts: [],
      cardinalityConstraints: [],
      artifacts: [
        {
          descriptorId: `${nodeId}:manifest`,
          digest: {
            algorithm: 'sha256' as const,
            value: digest.slice('sha256:'.length),
          },
          size: pulled.descriptor.size,
          mediaType: manifest.mediaType,
          artifactType: manifest.artifactType ?? 'application/vnd.oci.image',
          nativeRole: 'oci-manifest' as const,
          locations: [
            {
              transport: 'oci' as const,
              uri: `https://${reference.registry}/v2/${reference.repository}/manifests/${digest}`,
              priority: 0,
              rangeSupported: false,
            },
          ],
          referrers: [],
          externalRefs: [],
        },
      ],
      lifecycle: {
        status: 'unknown' as const,
        eligible: true,
        warnings: [
          {
            code: 'LIFECYCLE_NOT_CAPTURED',
            message:
              'OCI registries publish no lifecycle status; deprecation and revocation were not consulted',
          },
        ],
      },
      sourceSnapshots: [],
      metadataDigest: await sha256(
        new TextEncoder().encode(JSON.stringify(manifest)),
      ),
      nativeSemantics: {
        version: 'oci-v1',
        // SAFETY: The OCI manifest has been validated by the registry client.
        data: JSON.parse(JSON.stringify(manifest)) as JsonValue,
      },
      semanticLoss: [],
    } as PackageInstance;

    return {
      package: instance,
      record: {
        key: resolved,
        endpoint: `https://${reference.registry}/v2/${reference.repository}/manifests/${target}`,
        body: manifest,
        rawBody: pulled.bytes,
        retrievedAt: this.options.now?.() ?? new Date().toISOString(),
      },
      warnings: [],
    };
  }

  /**
   * Materialise an image into one verifiable artifact: an OCI image layout
   * packed as ustar.
   *
   * Browse/pin (`inspect`) only needs the manifest. Install needs the config
   * and every layer too, each digest-checked against its descriptor, then
   * assembled into the layout a container runtime expects. The layout tar's
   * own sha256 is what the store verifies; the image manifest digest remains
   * the PURL version (identity), which is a different statement.
   */
  async fetchArtifactRecord(
    exactPurl: string,
    signal?: AbortSignal,
  ): Promise<ProviderRecord> {
    const reference = parseOciPurl(exactPurl);
    const target = reference.digest ?? reference.tag;
    if (target === undefined)
      throw new ProviderError(
        'INVALID_PURL',
        `${exactPurl} names neither a tag nor a digest`,
      );

    const client = this.#client(reference);
    const pulled = await client.pullManifest(target, undefined, signal);
    const image = await this.#resolveImageManifest(client, pulled, signal);
    const layout = await this.#packImageLayout(client, image, signal);
    const digestValue = (await sha256(layout.bytes)).value;
    const uri = `https://${reference.registry}/v2/${reference.repository}/manifests/${image.digest}`;

    return {
      key: purlFor(reference, { kind: 'digest', digest: image.digest }),
      endpoint: uri,
      body: {
        digest: { algorithm: 'sha256', value: digestValue },
        size: layout.bytes.byteLength,
        mediaType: 'application/vnd.oci.image.layout.v1.tar',
        locations: [
          {
            transport: 'oci',
            uri,
            priority: 0,
            rangeSupported: false,
          },
        ],
        referrers: [],
        externalRefs: [],
        nativeRole: 'oci-image-layout',
        imageDigest: image.digest,
      },
      rawBody: layout.bytes,
      retrievedAt: this.options.now?.() ?? new Date().toISOString(),
    };
  }

  /**
   * Resolve an index or list to a single image manifest for this host.
   *
   * Multi-arch tags publish an index. Identity still ends at a digest; the
   * choice of which platform digest is for *this* materialisation and is
   * recorded on the layout, not smuggled into a tag.
   */
  async #resolveImageManifest(
    client: OciRegistryClient,
    pulled: {
      descriptor: OciDescriptor;
      bytes: Uint8Array;
      manifest: OciManifest;
    },
    signal?: AbortSignal,
  ): Promise<{
    digest: string;
    bytes: Uint8Array;
    manifest: OciManifest;
  }> {
    if (isImageMediaType(pulled.descriptor.mediaType)) {
      return {
        digest: pulled.descriptor.digest,
        bytes: pulled.bytes,
        manifest: pulled.manifest,
      };
    }
    if (!isIndexMediaType(pulled.descriptor.mediaType))
      throw new ProviderError(
        'INVALID_PROVIDER_METADATA',
        `Unsupported OCI media type ${pulled.descriptor.mediaType}`,
      );

    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const index = pulled.manifest as unknown as OciIndex & {
      manifests: Array<
        OciDescriptor & {
          platform?: { os?: string; architecture?: string; variant?: string };
        }
      >;
    };
    const selected = selectPlatformManifest(index.manifests);
    if (selected === undefined)
      throw new ProviderError(
        'ARTIFACT_NOT_FOUND',
        `No image manifest matches this host (${hostPlatform().os}/${hostPlatform().architecture}) ` +
          `and the index published no usable fallback`,
      );
    const image = await client.pullManifest(selected.digest, undefined, signal);
    if (!isImageMediaType(image.descriptor.mediaType))
      throw new ProviderError(
        'INVALID_PROVIDER_METADATA',
        `Platform entry ${selected.digest} is not an image manifest`,
      );
    return {
      digest: image.descriptor.digest,
      bytes: image.bytes,
      manifest: image.manifest,
    };
  }

  async #packImageLayout(
    client: OciRegistryClient,
    image: { digest: string; bytes: Uint8Array; manifest: OciManifest },
    signal?: AbortSignal,
  ): Promise<{ bytes: Uint8Array }> {
    if (image.manifest.layers.length > OCI_MATERIALIZATION_LIMITS.maximumLayers)
      throw new ProviderError(
        'INVALID_PROVIDER_METADATA',
        `OCI image has more than ${OCI_MATERIALIZATION_LIMITS.maximumLayers} layers`,
      );

    const files = new Map<string, AsyncTarFile>();
    const putBlob = (
      digest: string,
      size: number,
      body: () => Promise<Uint8Array>,
    ) => {
      const hex = digest.startsWith('sha256:')
        ? digest.slice('sha256:'.length)
        : digest;
      const path = `blobs/sha256/${hex}`;
      const previous = files.get(path);
      if (previous && previous.size !== size)
        throw new ProviderError(
          'INVALID_PROVIDER_METADATA',
          `OCI digest ${digest} has contradictory sizes`,
        );
      if (!previous) files.set(path, { path, size, body });
    };

    putBlob(image.digest, image.bytes.byteLength, async () => image.bytes);
    putBlob(
      image.manifest.config.digest,
      image.manifest.config.size,
      async () => await client.pullBlob(image.manifest.config, signal),
    );
    for (const layer of image.manifest.layers)
      putBlob(
        layer.digest,
        layer.size,
        async () => await client.pullBlob(layer, signal),
      );

    const indexDocument = {
      schemaVersion: 2,
      mediaType: OCI_MEDIA_TYPES.index,
      manifests: [
        {
          mediaType: image.manifest.mediaType ?? OCI_MEDIA_TYPES.manifest,
          digest: image.digest,
          size: image.bytes.byteLength,
          platform: hostPlatform(),
        },
      ],
    };
    const indexBytes = new TextEncoder().encode(
      `${JSON.stringify(indexDocument)}\n`,
    );
    const layoutBytes = new TextEncoder().encode(
      `${JSON.stringify({ imageLayoutVersion: '1.0.0' })}\n`,
    );
    files.set('index.json', {
      path: 'index.json',
      size: indexBytes.byteLength,
      body: async () => indexBytes,
    });
    files.set('oci-layout', {
      path: 'oci-layout',
      size: layoutBytes.byteLength,
      body: async () => layoutBytes,
    });

    try {
      return {
        bytes: await packUstarAsync(
          [...files.values()],
          OCI_MATERIALIZATION_LIMITS.maximumLayoutBytes,
        ),
      };
    } catch (error) {
      if (error instanceof RangeError)
        throw new ProviderError('INVALID_PROVIDER_METADATA', error.message);
      throw error;
    }
  }

  async snapshot(evaluationTime: string): Promise<SourceSnapshot> {
    throw new ProviderError(
      'PROVIDER_CAPABILITY_MISSING',
      `OCI registries do not produce catalog snapshots (asked at ${evaluationTime}).`,
    );
  }
}

/** Host platform as OCI names it. */
export function hostPlatform() {
  const os =
    process.platform === 'win32'
      ? 'windows'
      : process.platform === 'darwin'
        ? 'darwin'
        : 'linux';
  const architecture =
    process.arch === 'x64'
      ? 'amd64'
      : process.arch === 'arm64'
        ? 'arm64'
        : process.arch;
  return { os, architecture };
}

/**
 * Pick one platform-specific manifest from an index.
 *
 * Prefer an exact os/arch match for this host; if the index only publishes
 * one image (common for single-arch tags served as a trivial index), take
 * it. Otherwise fail closed — guessing the wrong arch is worse than refusing.
 */
export function selectPlatformManifest(
  manifests: ReadonlyArray<
    OciDescriptor & {
      platform?: { os?: string; architecture?: string; variant?: string };
    }
  >,
):
  | (OciDescriptor & {
      platform?: { os?: string; architecture?: string; variant?: string };
    })
  | undefined {
  const host = hostPlatform();
  const images = manifests.filter(
    (entry) =>
      entry.mediaType === OCI_MEDIA_TYPES.manifest ||
      entry.mediaType === DOCKER_MEDIA_TYPES.manifest ||
      entry.mediaType === undefined,
  );
  if (images.length === 0) return undefined;

  const exact = images.find(
    (entry) =>
      entry.platform?.os === host.os &&
      entry.platform?.architecture === host.architecture,
  );
  if (exact) return exact;

  // Single entry with no platform, or one entry total: the publisher made the
  // choice already.
  if (images.length === 1) return images[0];

  const unplatformed = images.filter((entry) => entry.platform === undefined);
  if (unplatformed.length === 1) return unplatformed[0];

  return undefined;
}
