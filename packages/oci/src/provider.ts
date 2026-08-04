import {
  ProviderError,
  formatPurl,
  packageNodeId,
  parsePurl,
  type CatalogProvider,
  type ProviderCapabilities,
  type ProviderInspection,
  type ProviderRecord,
} from '@openpacker/adapter-core';
import type {
  PackageIdentity,
  PackageInstance,
  SourceSnapshot,
} from '@openpacker/contracts';
import { sha256 } from '@openpacker/canonical';
import {
  BearerTokenAuthentication,
  OciRegistryClient,
  type OciManifest,
  type RegistryAuthentication,
} from './index.js';

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
    ...(tag === undefined ? {} : { tag }),
    ...(digest === undefined ? {} : { digest }),
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
      ...(pin.kind === 'tag' ? { tag: pin.tag } : {}),
    },
    ...(pin.kind === 'digest' ? { version: pin.digest } : {}),
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

  constructor(
    private readonly options: {
      fetch?: typeof fetch;
      authentication?: RegistryAuthentication;
      now?: () => string;
    } = {},
  ) {}

  #client(reference: OciRepositoryReference): OciRegistryClient {
    return new OciRegistryClient({
      registry: `https://${reference.registry}`,
      repository: reference.repository,
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
      authentication:
        this.options.authentication ??
        new BearerTokenAuthentication(
          this.options.fetch ? { fetch: this.options.fetch } : {},
        ),
    });
  }

  async identify(query: string): Promise<readonly PackageIdentity[]> {
    // Registries have no search API in the distribution specification, so this
    // canonicalizes a reference rather than pretending to discover one.
    const reference = parseOciPurl(
      query.startsWith('pkg:') ? query : `pkg:oci/${query}`,
    );
    return [
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
      } as unknown as PackageIdentity,
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
    const manifest = pulled.manifest as OciManifest;
    const digest = pulled.descriptor.digest;

    const canonicalPurl = purlFor(reference, { kind: 'repository' });
    const resolved = purlFor(reference, { kind: 'digest', digest });
    const nodeId = await packageNodeId({
      exactPurl: resolved,
      qualifiers: parsePurl(resolved).qualifiers,
      nativeSemanticsVersion: 'oci-v1',
    });

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
        data: manifest as unknown as Record<string, unknown>,
      },
      semanticLoss: [],
    } as unknown as PackageInstance;

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

  async fetchArtifactRecord(
    exactPurl: string,
    signal?: AbortSignal,
  ): Promise<ProviderRecord> {
    const inspection = await this.inspect(exactPurl, signal);
    return {
      ...inspection.record,
      body: inspection.package.artifacts[0],
    };
  }

  async snapshot(evaluationTime: string): Promise<SourceSnapshot> {
    return {
      snapshotVersion: '1',
      providerId: this.providerId,
      evaluationTime,
      sources: [],
    } as unknown as SourceSnapshot;
  }
}
