import { createHash, randomBytes } from 'node:crypto';
import {
  link,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import {
  collectStream,
  descriptorForBytes,
  streamFromBytes,
  verifyBytes,
} from '@openpacker/artifact-model';
import {
  canonicalBytes,
  compareCanonicalStrings,
  parseDigest,
  sha256,
} from '@openpacker/canonical';
import type { ArtifactDescriptor, JsonValue } from '@openpacker/contracts';

export const OCI_MEDIA_TYPES = {
  manifest: 'application/vnd.oci.image.manifest.v1+json',
  index: 'application/vnd.oci.image.index.v1+json',
  emptyConfig: 'application/vnd.oci.empty.v1+json',
} as const;

/**
 * Docker's pre-OCI media types.
 *
 * Docker Hub still serves these for most repositories, and a client that only
 * accepts the OCI types is told the manifest is unknown for the majority of
 * real tags. Recognised for reading; nothing is written in these types.
 */
export const DOCKER_MEDIA_TYPES = {
  manifest: 'application/vnd.docker.distribution.manifest.v2+json',
  list: 'application/vnd.docker.distribution.manifest.list.v2+json',
} as const;

/** Media types that name a set of platform-specific manifests. */
const INDEX_MEDIA_TYPES: ReadonlySet<string> = new Set([
  OCI_MEDIA_TYPES.index,
  DOCKER_MEDIA_TYPES.list,
]);

/** Media types that name a single image. */
const IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set([
  OCI_MEDIA_TYPES.manifest,
  DOCKER_MEDIA_TYPES.manifest,
]);

export function isIndexMediaType(mediaType: string): boolean {
  return INDEX_MEDIA_TYPES.has(mediaType);
}

export function isImageMediaType(mediaType: string): boolean {
  return IMAGE_MEDIA_TYPES.has(mediaType);
}

export const OCI_EMPTY_CONFIG_BYTES = canonicalBytes({});

export interface OciDescriptor {
  mediaType: string;
  digest: string;
  size: number;
  artifactType?: string;
  annotations?: Record<string, string>;
}

export interface OciManifest {
  schemaVersion: 2;
  mediaType: typeof OCI_MEDIA_TYPES.manifest;
  artifactType?: string;
  config: OciDescriptor;
  layers: OciDescriptor[];
  subject?: OciDescriptor;
  annotations?: Record<string, string>;
}

export interface OciIndex {
  schemaVersion: 2;
  mediaType: typeof OCI_MEDIA_TYPES.index;
  manifests: OciDescriptor[];
}

export interface PackedArtifact {
  manifest: OciDescriptor;
  nativeBlob: OciDescriptor;
  artifact: ArtifactDescriptor;
}

const digestValue = (digest: string): string => parseDigest(digest).value;
const descriptorDigest = (descriptor: OciDescriptor): string =>
  digestValue(descriptor.digest);

export function validateOciDescriptor(descriptor: OciDescriptor): void {
  parseDigest(descriptor.digest);
  if (!Number.isSafeInteger(descriptor.size) || descriptor.size < 0)
    throw new TypeError(
      'OCI descriptor size must be a non-negative safe integer',
    );
  if (!descriptor.mediaType || descriptor.mediaType.length > 255)
    throw new TypeError('OCI descriptor mediaType is required and bounded');
}

export async function ociDescriptor(
  bytes: Uint8Array,
  mediaType: string,
  extras: Pick<OciDescriptor, 'artifactType' | 'annotations'> = {},
): Promise<OciDescriptor> {
  const digest = await sha256(bytes);
  const descriptor: OciDescriptor = {
    mediaType,
    digest: `sha256:${digest.value}`,
    size: bytes.byteLength,
  };
  if (extras.artifactType !== undefined)
    descriptor.artifactType = extras.artifactType;
  if (extras.annotations !== undefined)
    descriptor.annotations = extras.annotations;
  return descriptor;
}

const parseJson = <T>(bytes: Uint8Array): T =>
  JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as T;

export class OciImageLayout {
  private indexUpdate: Promise<void> = Promise.resolve();

  constructor(readonly root: string) {}

  async initialize(): Promise<void> {
    await mkdir(join(this.root, 'blobs', 'sha256'), { recursive: true });
    await writeFile(
      join(this.root, 'oci-layout'),
      '{"imageLayoutVersion":"1.0.0"}\n',
      { flag: 'wx' },
    ).catch(ignoreExists);
    await writeFile(
      join(this.root, 'index.json'),
      canonicalBytes({
        schemaVersion: 2,
        mediaType: OCI_MEDIA_TYPES.index,
        manifests: [],
      }),
      { flag: 'wx' },
    ).catch(ignoreExists);
  }

  private blobPath(descriptor: OciDescriptor): string {
    validateOciDescriptor(descriptor);
    return join(this.root, 'blobs', 'sha256', descriptorDigest(descriptor));
  }

  async putBlob(
    bytes: Uint8Array,
    mediaType: string,
    extras: Pick<OciDescriptor, 'artifactType' | 'annotations'> = {},
  ): Promise<OciDescriptor> {
    await this.initialize();
    const descriptor = await ociDescriptor(bytes, mediaType, extras);
    const temporary = join(
      this.root,
      `.blob-${randomBytes(12).toString('hex')}`,
    );
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    try {
      await link(temporary, this.blobPath(descriptor));
    } catch (error) {
      if (!isCode(error, 'EEXIST')) throw error;
      const existing = await stat(this.blobPath(descriptor));
      if (existing.size !== bytes.byteLength)
        throw new Error('Immutable OCI blob has an inconsistent size');
    } finally {
      await rm(temporary, { force: true });
    }
    return descriptor;
  }

  async getBlob(
    descriptor: OciDescriptor,
    maximumBytes = descriptor.size,
  ): Promise<Uint8Array> {
    validateOciDescriptor(descriptor);
    if (descriptor.size > maximumBytes)
      throw new RangeError(`OCI blob exceeds ${maximumBytes} bytes`);
    const bytes = new Uint8Array(await readFile(this.blobPath(descriptor)));
    const artifact = await descriptorForBytes({
      bytes: new Uint8Array(bytes),
      descriptorId: descriptor.digest,
      mediaType: descriptor.mediaType,
      artifactType: descriptor.artifactType ?? 'application/vnd.oci.blob',
      nativeRole: 'oci-blob',
    });
    if (artifact.size !== descriptor.size)
      throw new Error('OCI blob size mismatch');
    if (`sha256:${artifact.digest.value}` !== descriptor.digest)
      throw new Error('OCI blob digest mismatch');
    return bytes;
  }

  async putManifest(
    manifest: OciManifest,
    reference?: string,
  ): Promise<OciDescriptor> {
    validateManifest(manifest);
    const bytes = canonicalBytes(manifest as unknown as JsonValue);
    const descriptor = await this.putBlob(
      bytes,
      OCI_MEDIA_TYPES.manifest,
      manifest.artifactType === undefined
        ? {}
        : { artifactType: manifest.artifactType },
    );
    await this.addToIndex({
      ...descriptor,
      ...(reference === undefined
        ? {}
        : { annotations: { 'org.opencontainers.image.ref.name': reference } }),
    });
    return descriptor;
  }

  async readManifest(descriptor: OciDescriptor): Promise<OciManifest> {
    if (descriptor.mediaType !== OCI_MEDIA_TYPES.manifest)
      throw new TypeError('Descriptor is not an OCI manifest');
    const manifest = parseJson<OciManifest>(
      await this.getBlob(descriptor, 16 * 1024 * 1024),
    );
    validateManifest(manifest);
    return manifest;
  }

  async listReferrers(
    subject: OciDescriptor,
    artifactType?: string,
  ): Promise<OciDescriptor[]> {
    const index = await this.readIndex();
    const result: OciDescriptor[] = [];
    for (const descriptor of index.manifests) {
      if (descriptor.mediaType !== OCI_MEDIA_TYPES.manifest) continue;
      const manifest = await this.readManifest(descriptor);
      if (
        manifest.subject?.digest === subject.digest &&
        (artifactType === undefined || manifest.artifactType === artifactType)
      )
        result.push(descriptor);
    }
    return result.sort((left, right) =>
      compareCanonicalStrings(left.digest, right.digest),
    );
  }

  async packNative(input: {
    bytes: Uint8Array;
    exactPurl: string;
    nativeMediaType: string;
    artifactType: string;
    fileName: string;
    reference?: string;
  }): Promise<PackedArtifact> {
    const nativeBlob = await this.putBlob(input.bytes, input.nativeMediaType, {
      annotations: { 'org.opencontainers.image.title': input.fileName },
    });
    const emptyConfig = await this.putBlob(
      OCI_EMPTY_CONFIG_BYTES,
      OCI_MEDIA_TYPES.emptyConfig,
    );
    const manifest: OciManifest = {
      schemaVersion: 2,
      mediaType: OCI_MEDIA_TYPES.manifest,
      artifactType: input.artifactType,
      config: emptyConfig,
      layers: [nativeBlob],
      annotations: {
        'org.opencontainers.image.title': input.fileName,
        'org.opencontainers.image.version': input.exactPurl,
        'org.opencontainers.image.ref.name': input.exactPurl,
      },
    };
    const manifestDescriptor = await this.putManifest(
      manifest,
      input.reference,
    );
    const artifact = await descriptorForBytes({
      bytes: input.bytes,
      descriptorId: input.exactPurl,
      mediaType: input.nativeMediaType,
      artifactType: input.artifactType,
      nativeRole: 'native-package',
      fileName: input.fileName,
    });
    artifact.oci = {
      manifestDigest: manifestDescriptor.digest,
      blobDigest: nativeBlob.digest,
    };
    return { manifest: manifestDescriptor, nativeBlob, artifact };
  }

  async attachReferrer(
    subject: OciDescriptor,
    bytes: Uint8Array,
    artifactType: string,
    mediaType: string,
    annotations?: Record<string, string>,
  ): Promise<OciDescriptor> {
    const payload = await this.putBlob(bytes, mediaType);
    const emptyConfig = await this.putBlob(
      OCI_EMPTY_CONFIG_BYTES,
      OCI_MEDIA_TYPES.emptyConfig,
    );
    const manifest: OciManifest = {
      schemaVersion: 2,
      mediaType: OCI_MEDIA_TYPES.manifest,
      artifactType,
      config: emptyConfig,
      layers: [payload],
      subject,
    };
    if (annotations !== undefined) manifest.annotations = annotations;
    return this.putManifest(manifest);
  }

  private async readIndex(): Promise<OciIndex> {
    await this.initialize();
    const index = parseJson<OciIndex>(
      new Uint8Array(await readFile(join(this.root, 'index.json'))),
    );
    if (
      index.schemaVersion !== 2 ||
      index.mediaType !== OCI_MEDIA_TYPES.index ||
      !Array.isArray(index.manifests)
    )
      throw new TypeError('Invalid OCI image-layout index');
    return index;
  }

  private async addToIndex(descriptor: OciDescriptor): Promise<void> {
    const update = this.indexUpdate.then(() => this.writeIndex(descriptor));
    this.indexUpdate = update.catch(() => undefined);
    await update;
  }

  private async writeIndex(descriptor: OciDescriptor): Promise<void> {
    const index = await this.readIndex();
    const key = `${descriptor.digest}\u0000${descriptor.annotations?.['org.opencontainers.image.ref.name'] ?? ''}`;
    const manifests = [
      ...index.manifests.filter(
        (item) =>
          `${item.digest}\u0000${item.annotations?.['org.opencontainers.image.ref.name'] ?? ''}` !==
          key,
      ),
      descriptor,
    ].sort(
      (left, right) =>
        compareCanonicalStrings(left.digest, right.digest) ||
        compareCanonicalStrings(
          left.annotations?.['org.opencontainers.image.ref.name'] ?? '',
          right.annotations?.['org.opencontainers.image.ref.name'] ?? '',
        ),
    );
    const temporary = join(
      this.root,
      `.index-${randomBytes(12).toString('hex')}`,
    );
    await writeFile(
      temporary,
      canonicalBytes({ ...index, manifests } as unknown as JsonValue),
      { flag: 'wx', mode: 0o600 },
    );
    await rename(temporary, join(this.root, 'index.json'));
  }
}

export interface RegistryAuthentication {
  headers(
    requestUrl: URL,
    scope: string,
    signal?: AbortSignal,
  ): Promise<Readonly<Record<string, string>>>;
}

/**
 * The token handshake every public OCI registry uses.
 *
 * A registry answers an unauthenticated request with 401 and a
 * `WWW-Authenticate: Bearer realm=…,service=…` challenge; the realm issues a
 * short-lived token for a named scope. ghcr.io and Docker Hub both require
 * this even for public, anonymous pulls, so without it `opm` could not read a
 * public image at all.
 *
 * Credentials are optional. When absent this performs the anonymous flow,
 * which is what public repositories serve.
 */
export class BearerTokenAuthentication implements RegistryAuthentication {
  readonly #tokens = new Map<string, { token: string; expiresAt: number }>();
  readonly #fetch: typeof fetch;
  readonly #credentials: { username: string; password: string } | undefined;
  readonly #now: () => number;
  readonly #allowedTokenOrigins: ReadonlySet<string>;

  /**
   * Token endpoints that well-known registries legitimately delegate to.
   *
   * Curated here rather than learned from a response: the point of the check
   * is that the list is not attacker-influenced. Anything else needs
   * `allowedTokenOrigins`.
   */
  static readonly WELL_KNOWN_TOKEN_ORIGINS: Readonly<
    Record<string, readonly string[]>
  > = {
    'https://registry-1.docker.io': ['https://auth.docker.io'],
    'https://index.docker.io': ['https://auth.docker.io'],
    'https://ghcr.io': ['https://ghcr.io'],
    'https://quay.io': ['https://quay.io'],
  };

  constructor(
    options: {
      fetch?: typeof fetch;
      credentials?: { username: string; password: string };
      now?: () => number;
      /** Extra origins this caller authorizes to receive its credentials. */
      allowedTokenOrigins?: readonly string[];
    } = {},
  ) {
    this.#fetch = options.fetch ?? fetch;
    this.#credentials = options.credentials;
    this.#now = options.now ?? (() => Date.now());
    this.#allowedTokenOrigins = new Set(
      (options.allowedTokenOrigins ?? []).map((value) => new URL(value).origin),
    );
  }

  /** Where this registry's credentials may be sent. */
  #credentialOrigins(requestUrl: URL): ReadonlySet<string> {
    return new Set([
      // A registry issuing its own tokens is the common case and is not a
      // delegation at all.
      requestUrl.origin,
      ...(BearerTokenAuthentication.WELL_KNOWN_TOKEN_ORIGINS[
        requestUrl.origin
      ] ?? []),
      ...this.#allowedTokenOrigins,
    ]);
  }

  async headers(
    requestUrl: URL,
    scope: string,
    signal?: AbortSignal,
  ): Promise<Readonly<Record<string, string>>> {
    const key = `${requestUrl.origin}|${scope}`;
    const cached = this.#tokens.get(key);
    if (cached && cached.expiresAt > this.#now())
      return { authorization: `Bearer ${cached.token}` };

    const probe = await this.#fetch(requestUrl, {
      method: 'GET',
      redirect: 'manual',
      ...(signal ? { signal } : {}),
    });
    if (probe.status !== 401) {
      await probe.body?.cancel();
      return {};
    }
    const challenge = probe.headers.get('www-authenticate') ?? '';
    await probe.body?.cancel();
    if (!/^bearer/iu.test(challenge)) return {};

    const field = (name: string) =>
      challenge.match(new RegExp(`${name}="([^"]+)"`, 'iu'))?.[1];
    const realm = field('realm');
    if (!realm) return {};
    const tokenUrl = new URL(realm);
    // The realm is chosen by the server being talked to. Over plaintext it
    // would put the issued token — and any credentials — on the wire.
    if (tokenUrl.protocol !== 'https:')
      throw new RegistryProtocolError(
        'UNSAFE_REDIRECT',
        `Registry ${requestUrl.origin} named a non-HTTPS token endpoint: ${tokenUrl.origin}`,
      );
    const service = field('service');
    if (service) tokenUrl.searchParams.set('service', service);
    tokenUrl.searchParams.set('scope', field('scope') ?? scope);

    const requestHeaders: Record<string, string> = {
      accept: 'application/json',
    };
    if (this.#credentials) {
      // Credentials go only to a token endpoint the caller authorized, never
      // to one the registry named for itself. A hostile, compromised, or
      // typo-squatted registry can otherwise answer any request with
      // `realm="https://attacker/token"` and be handed the user's password.
      // The anonymous flow below still follows any HTTPS realm, because it
      // discloses nothing.
      if (!this.#credentialOrigins(requestUrl).has(tokenUrl.origin))
        throw new RegistryProtocolError(
          'UNAUTHORIZED',
          `${requestUrl.origin} asked for credentials to be sent to ${tokenUrl.origin}, ` +
            `which is not an authorized token endpoint for it. ` +
            `Pass allowedTokenOrigins if this is intended.`,
        );
      requestHeaders.authorization = `Basic ${Buffer.from(
        `${this.#credentials.username}:${this.#credentials.password}`,
      ).toString('base64')}`;
    }

    const response = await this.#fetch(tokenUrl, {
      method: 'GET',
      headers: requestHeaders,
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new RegistryProtocolError(
        'UNAUTHORIZED',
        `Token request to ${tokenUrl.origin} failed: HTTP ${response.status}`,
      );
    }
    const body = (await response.json()) as {
      token?: string;
      access_token?: string;
      expires_in?: number;
    };
    const token = body.token ?? body.access_token;
    if (!token)
      throw new RegistryProtocolError(
        'UNAUTHORIZED',
        `Token endpoint ${tokenUrl.origin} returned no token`,
      );
    // Expire early so a token cannot lapse mid-request.
    const lifetime = Math.max(30, body.expires_in ?? 300) - 15;
    this.#tokens.set(key, {
      token,
      expiresAt: this.#now() + lifetime * 1000,
    });
    return { authorization: `Bearer ${token}` };
  }
}

export class OciRegistryClient {
  readonly registry: URL;
  readonly repository: string;

  constructor(input: {
    registry: string | URL;
    repository: string;
    fetch?: typeof fetch;
    authentication?: RegistryAuthentication;
    maximumAttempts?: number;
    retryDelayMilliseconds?: number;
    monolithicUploadMaximumBytes?: number;
  }) {
    this.registry = new URL(input.registry);
    if (
      this.registry.username ||
      this.registry.password ||
      this.registry.search ||
      this.registry.hash
    )
      throw new TypeError(
        'Registry URL must not contain credentials, query, or fragment',
      );
    if (!/^[a-z0-9]+(?:(?:[._-]|\/)[a-z0-9]+)*$/u.test(input.repository))
      throw new TypeError('Invalid OCI repository name');
    this.repository = input.repository;
    this.fetchImplementation = input.fetch ?? globalThis.fetch;
    this.authentication = input.authentication;
    this.maximumAttempts = input.maximumAttempts ?? 3;
    this.retryDelayMilliseconds = input.retryDelayMilliseconds ?? 50;
    this.monolithicUploadMaximumBytes =
      input.monolithicUploadMaximumBytes ?? 4 * 1024 * 1024;
    if (
      !Number.isSafeInteger(this.maximumAttempts) ||
      this.maximumAttempts < 1 ||
      this.maximumAttempts > 5
    )
      throw new RangeError('maximumAttempts must be between 1 and 5');
    if (
      !Number.isSafeInteger(this.retryDelayMilliseconds) ||
      this.retryDelayMilliseconds < 0 ||
      this.retryDelayMilliseconds > 1_000
    )
      throw new RangeError('retryDelayMilliseconds must be between 0 and 1000');
    if (
      !Number.isSafeInteger(this.monolithicUploadMaximumBytes) ||
      this.monolithicUploadMaximumBytes < 0 ||
      this.monolithicUploadMaximumBytes > 64 * 1024 * 1024
    )
      throw new RangeError(
        'monolithicUploadMaximumBytes must be between 0 and 64 MiB',
      );
  }

  private readonly fetchImplementation: typeof fetch;
  private readonly authentication: RegistryAuthentication | undefined;
  private readonly maximumAttempts: number;
  private readonly retryDelayMilliseconds: number;
  private readonly monolithicUploadMaximumBytes: number;

  private endpoint(path: string): URL {
    return new URL(`/v2/${this.repository}/${path}`, this.registry);
  }

  private async request(
    url: URL,
    init: RequestInit,
    scope: string,
    signal?: AbortSignal,
  ): Promise<Response> {
    if (url.origin !== this.registry.origin)
      throw new RegistryProtocolError(
        'UNSAFE_REDIRECT',
        'Registry upload redirected to another origin',
      );
    const authentication = await this.authentication?.headers(
      url,
      scope,
      signal,
    );
    const headers = new Headers(init.headers);
    for (const [key, value] of Object.entries(authentication ?? {}))
      headers.set(key, value);
    const request: RequestInit = { ...init, headers, redirect: 'manual' };
    if (signal !== undefined) request.signal = signal;
    return this.fetchImplementation(url, request);
  }

  private async retryableRequest(
    url: URL,
    init: RequestInit,
    scope: string,
    signal?: AbortSignal,
  ): Promise<Response> {
    for (let attempt = 1; ; attempt += 1) {
      let response: Response;
      try {
        response = await this.request(url, init, scope, signal);
      } catch (error) {
        if (attempt >= this.maximumAttempts || signal?.aborted) throw error;
        await abortableDelay(this.retryDelayMilliseconds, signal);
        continue;
      }
      if (
        attempt >= this.maximumAttempts ||
        ![408, 429, 500, 502, 503, 504].includes(response.status)
      )
        return response;
      await response.body?.cancel();
      await abortableDelay(this.retryDelayMilliseconds, signal);
    }
  }

  /**
   * Every tag in the repository, in the order the registry returns them.
   *
   * Paginated through the `Link: <...>; rel="next"` header the distribution
   * specification defines. Registries cap `n` server-side, so a repository
   * with thousands of tags needs the follow rather than one large request.
   */
  async listTags(options: { signal?: AbortSignal } = {}): Promise<string[]> {
    const tags: string[] = [];
    let next: URL | undefined = this.endpoint('tags/list');
    const seen = new Set<string>();
    while (next) {
      // A registry that keeps pointing at pages terminates here rather than
      // looping forever.
      if (seen.has(next.href)) break;
      seen.add(next.href);
      const response: Response = await this.retryableRequest(
        next,
        { method: 'GET', headers: { accept: 'application/json' } },
        `repository:${this.repository}:pull`,
        options.signal,
      );
      if (response.status === 404)
        throw new RegistryProtocolError(
          'NOT_FOUND',
          `Repository ${this.repository} not found on ${this.registry.origin}`,
        );
      if (response.status < 200 || response.status >= 300)
        throw new RegistryProtocolError(
          'UNEXPECTED_STATUS',
          `Listing tags failed: HTTP ${response.status}`,
        );
      const body = (await response.json()) as { tags?: unknown };
      if (Array.isArray(body.tags))
        for (const tag of body.tags)
          if (typeof tag === 'string') tags.push(tag);

      const link = response.headers.get('link');
      const match = link?.match(/<([^>]+)>\s*;\s*rel="?next"?/iu);
      next = match?.[1] ? new URL(match[1], this.registry) : undefined;
      // Following a next-link to another host would take the listing
      // somewhere the caller never authorized.
      if (next && next.origin !== this.registry.origin)
        throw new RegistryProtocolError(
          'UNSAFE_REDIRECT',
          'Tag pagination pointed at another origin',
        );
    }
    return tags;
  }

  async blobExists(
    descriptor: OciDescriptor,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const response = await this.retryableRequest(
      this.endpoint(`blobs/${encodeURIComponent(descriptor.digest)}`),
      { method: 'HEAD' },
      `repository:${this.repository}:pull`,
      signal,
    );
    if (response.status === 404) return false;
    if (!response.ok) throw await registryError(response);
    return true;
  }

  async pushBlob(
    descriptor: OciDescriptor,
    stream: ReadableStream<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<void> {
    validateOciDescriptor(descriptor);
    if (await this.blobExists(descriptor, signal)) return;
    const started = await this.request(
      this.endpoint('blobs/uploads/'),
      { method: 'POST' },
      `repository:${this.repository}:push,pull`,
      signal,
    );
    if (started.status !== 202) throw await registryError(started);
    const location = started.headers.get('location');
    if (!location)
      throw new RegistryProtocolError(
        'INVALID_RESPONSE',
        'Registry upload response has no Location',
      );
    let upload = new URL(location, this.registry);
    if (descriptor.size <= this.monolithicUploadMaximumBytes) {
      const bytes = await collectStream(stream, descriptor.size, signal);
      if (bytes.byteLength !== descriptor.size)
        throw new RegistryProtocolError(
          'SIZE_MISMATCH',
          `Upload stream has ${bytes.byteLength} bytes, expected ${descriptor.size}`,
        );
      const actual = `sha256:${(await sha256(bytes)).value}`;
      if (actual !== descriptor.digest)
        throw new RegistryProtocolError(
          'DIGEST_MISMATCH',
          `Upload stream digest ${actual} does not match descriptor`,
        );
      upload.searchParams.set('digest', descriptor.digest);
      const completed = await this.request(
        upload,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/octet-stream' },
          body: new Blob([Uint8Array.from(bytes)]),
        },
        `repository:${this.repository}:push,pull`,
        signal,
      );
      validateUploadCompletion(completed, descriptor);
      return;
    }
    const reader = stream.getReader();
    const hash = createHash('sha256');
    let size = 0;
    try {
      while (true) {
        signal?.throwIfAborted();
        const item = await reader.read();
        if (item.done) break;
        if (!item.value || item.value.byteLength === 0) continue;
        size += item.value.byteLength;
        if (size > descriptor.size)
          throw new RegistryProtocolError(
            'SIZE_MISMATCH',
            'Upload stream exceeded descriptor size',
          );
        hash.update(item.value);
        const patched = await this.request(
          upload,
          {
            method: 'PATCH',
            headers: {
              'content-type': 'application/octet-stream',
              'content-range': `${size - item.value.byteLength}-${size - 1}`,
            },
            body: new Blob([Uint8Array.from(item.value)]),
          },
          `repository:${this.repository}:push,pull`,
          signal,
        );
        if (patched.status !== 202) throw await registryError(patched);
        const nextLocation = patched.headers.get('location');
        if (nextLocation) upload = new URL(nextLocation, upload);
      }
    } finally {
      reader.releaseLock();
    }
    if (size !== descriptor.size)
      throw new RegistryProtocolError(
        'SIZE_MISMATCH',
        `Upload stream has ${size} bytes, expected ${descriptor.size}`,
      );
    const actual = `sha256:${hash.digest('hex')}`;
    if (actual !== descriptor.digest)
      throw new RegistryProtocolError(
        'DIGEST_MISMATCH',
        `Upload stream digest ${actual} does not match descriptor`,
      );
    upload.searchParams.set('digest', descriptor.digest);
    const completed = await this.request(
      upload,
      { method: 'PUT', body: new Blob([]) },
      `repository:${this.repository}:push,pull`,
      signal,
    );
    validateUploadCompletion(completed, descriptor);
  }

  async pullBlob(
    descriptor: OciDescriptor,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const bytes = await collectStream(
      await this.openBlob(descriptor, undefined, signal),
      descriptor.size,
      signal,
    );
    const artifact = await descriptorForBytes({
      bytes,
      descriptorId: descriptor.digest,
      mediaType: descriptor.mediaType,
      artifactType: descriptor.artifactType ?? 'application/vnd.oci.blob',
      nativeRole: 'oci-blob',
    });
    await verifyBytes(artifact, bytes);
    if (
      artifact.size !== descriptor.size ||
      `sha256:${artifact.digest.value}` !== descriptor.digest
    )
      throw new RegistryProtocolError(
        'DIGEST_MISMATCH',
        'Downloaded blob does not match descriptor',
      );
    return bytes;
  }

  async openBlob(
    descriptor: OciDescriptor,
    range?: { offset: number; length?: number },
    signal?: AbortSignal,
  ): Promise<ReadableStream<Uint8Array>> {
    validateOciDescriptor(descriptor);
    if (
      range &&
      (!Number.isSafeInteger(range.offset) ||
        range.offset < 0 ||
        (range.length !== undefined &&
          (!Number.isSafeInteger(range.length) || range.length <= 0)))
    )
      throw new RangeError('Invalid OCI byte range');
    const headers = new Headers();
    let expectedRangeLength: number | undefined;
    if (range) {
      if (range.offset >= descriptor.size)
        throw new RangeError('Range starts at or after artifact end');
      expectedRangeLength = Math.min(
        range.length ?? descriptor.size - range.offset,
        descriptor.size - range.offset,
      );
      headers.set(
        'range',
        `bytes=${range.offset}-${range.offset + expectedRangeLength - 1}`,
      );
    }
    const response = await this.retryableRequest(
      this.endpoint(`blobs/${encodeURIComponent(descriptor.digest)}`),
      { method: 'GET', headers },
      `repository:${this.repository}:pull`,
      signal,
    );
    if (
      (!range && response.status !== 200) ||
      (range && response.status !== 206) ||
      !response.body
    )
      throw await registryError(response);
    if (range) {
      const expectedEnd = range.offset + expectedRangeLength! - 1;
      const contentRange = response.headers.get('content-range');
      const match = /^bytes (\d+)-(\d+)\/(\d+)$/u.exec(contentRange ?? '');
      if (
        !match ||
        Number(match[1]) !== range.offset ||
        Number(match[2]) !== expectedEnd ||
        Number(match[3]) !== descriptor.size
      ) {
        await response.body.cancel();
        throw new RegistryProtocolError(
          'INVALID_RANGE_RESPONSE',
          `Registry returned invalid Content-Range ${JSON.stringify(contentRange)}`,
        );
      }
      const contentLength = response.headers.get('content-length');
      if (
        contentLength !== null &&
        Number(contentLength) !== expectedRangeLength
      ) {
        await response.body.cancel();
        throw new RegistryProtocolError(
          'INVALID_RANGE_RESPONSE',
          `Registry returned invalid Content-Length ${JSON.stringify(contentLength)}`,
        );
      }
      return exactLengthStream(response.body, expectedRangeLength!);
    }
    const reader = response.body.getReader();
    const hash = createHash('sha256');
    let size = 0;
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        const item = await reader.read();
        if (item.done) {
          const actual = `sha256:${hash.digest('hex')}`;
          if (size !== descriptor.size)
            controller.error(
              new RegistryProtocolError(
                'SIZE_MISMATCH',
                `Downloaded ${size} bytes, expected ${descriptor.size}`,
              ),
            );
          else if (actual !== descriptor.digest)
            controller.error(
              new RegistryProtocolError(
                'DIGEST_MISMATCH',
                `Downloaded digest ${actual} does not match descriptor`,
              ),
            );
          else controller.close();
          return;
        }
        if (!item.value) return;
        size += item.value.byteLength;
        if (size > descriptor.size) {
          await reader.cancel();
          controller.error(
            new RegistryProtocolError(
              'SIZE_MISMATCH',
              'Downloaded stream exceeded descriptor size',
            ),
          );
          return;
        }
        hash.update(item.value);
        controller.enqueue(item.value);
      },
      async cancel(reason) {
        await reader.cancel(reason);
      },
    });
  }

  async pushManifest(
    reference: string,
    bytes: Uint8Array,
    descriptor: OciDescriptor,
    signal?: AbortSignal,
  ): Promise<void> {
    validateReference(reference);
    if (
      bytes.byteLength !== descriptor.size ||
      `sha256:${(await sha256(bytes)).value}` !== descriptor.digest
    )
      throw new RegistryProtocolError(
        'DIGEST_MISMATCH',
        'Manifest bytes do not match descriptor',
      );
    const response = await this.retryableRequest(
      this.endpoint(`manifests/${encodeURIComponent(reference)}`),
      {
        method: 'PUT',
        headers: { 'content-type': descriptor.mediaType },
        body: new Blob([Uint8Array.from(bytes)]),
      },
      `repository:${this.repository}:push,pull`,
      signal,
    );
    if (response.status !== 201 && response.status !== 202)
      throw await registryError(response);
  }

  async pullManifest(
    reference: string,
    maximumBytes = 16 * 1024 * 1024,
    signal?: AbortSignal,
  ): Promise<{
    descriptor: OciDescriptor;
    bytes: Uint8Array;
    manifest: OciManifest;
  }> {
    validateReference(reference);
    const response = await this.request(
      this.endpoint(`manifests/${encodeURIComponent(reference)}`),
      {
        method: 'GET',
        // Indexes and Docker's pre-OCI types are accepted for reading. Most
        // published tags are multi-arch indexes, and Docker Hub still serves
        // its own media types, so a client requesting only the OCI image
        // manifest is told "unknown manifest" for the majority of real tags.
        headers: {
          accept: [
            OCI_MEDIA_TYPES.index,
            OCI_MEDIA_TYPES.manifest,
            DOCKER_MEDIA_TYPES.list,
            DOCKER_MEDIA_TYPES.manifest,
          ].join(', '),
        },
      },
      `repository:${this.repository}:pull`,
      signal,
    );
    if (!response.ok || !response.body) throw await registryError(response);
    const bytes = await collectStream(response.body, maximumBytes, signal);
    const mediaType =
      response.headers.get('content-type')?.split(';')[0] ??
      OCI_MEDIA_TYPES.manifest;
    const descriptor = await ociDescriptor(bytes, mediaType);
    const returnedDigest = response.headers.get('docker-content-digest');
    if (returnedDigest && returnedDigest !== descriptor.digest)
      throw new RegistryProtocolError(
        'DIGEST_MISMATCH',
        'Registry manifest digest header is invalid',
      );
    if (reference.startsWith('sha256:') && descriptor.digest !== reference)
      throw new RegistryProtocolError(
        'DIGEST_MISMATCH',
        'Manifest digest does not match requested digest',
      );
    const manifest = parseJson<OciManifest>(bytes);
    // `mediaType` is optional inside the document — the OCI specification puts
    // it on the response — and ghcr.io omits it. So the transported type
    // decides, and a document that names a different one is a contradiction
    // rather than something to pick a winner from.
    if (
      manifest.mediaType !== undefined &&
      manifest.mediaType !== descriptor.mediaType
    )
      throw new RegistryProtocolError(
        'UNEXPECTED_STATUS',
        `Manifest declares ${manifest.mediaType} but was served as ${descriptor.mediaType}`,
      );
    const effective = { ...manifest, mediaType: descriptor.mediaType };
    // An index names platform manifests rather than layers, so the image
    // envelope check does not apply to it. Both stay digest-verified above,
    // which is what identity rests on.
    if (isIndexMediaType(descriptor.mediaType)) validateIndex(effective);
    else validateManifest(effective as OciManifest);
    return { descriptor, bytes, manifest: effective as OciManifest };
  }

  async listReferrers(
    subject: OciDescriptor,
    artifactType?: string,
    signal?: AbortSignal,
  ): Promise<OciDescriptor[]> {
    validateOciDescriptor(subject);
    const output: OciDescriptor[] = [];
    const visited = new Set<string>();
    let next: URL | undefined = this.endpoint(
      `referrers/${encodeURIComponent(subject.digest)}`,
    );
    if (artifactType !== undefined)
      next.searchParams.set('artifactType', artifactType);
    for (let page = 0; next && page < 100; page += 1) {
      if (visited.has(next.href))
        throw new RegistryProtocolError(
          'PAGINATION_LOOP',
          'Registry repeated a referrers pagination link',
        );
      visited.add(next.href);
      const response = await this.retryableRequest(
        next,
        { method: 'GET', headers: { accept: OCI_MEDIA_TYPES.index } },
        `repository:${this.repository}:pull`,
        signal,
      );
      if (!response.ok) throw await registryError(response);
      const index = (await response.json()) as OciIndex;
      if (
        index.schemaVersion !== 2 ||
        index.mediaType !== OCI_MEDIA_TYPES.index ||
        !Array.isArray(index.manifests)
      )
        throw new RegistryProtocolError(
          'INVALID_RESPONSE',
          'Invalid referrers index',
        );
      for (const descriptor of index.manifests)
        validateOciDescriptor(descriptor);
      output.push(...index.manifests);
      const link = response.headers.get('link');
      const match = link?.match(/<([^>]+)>;\s*rel="?next"?/u);
      next = match?.[1] ? new URL(match[1], next) : undefined;
      if (next && next.origin !== this.registry.origin)
        throw new RegistryProtocolError(
          'UNSAFE_REDIRECT',
          'Cross-origin pagination link rejected',
        );
    }
    if (next)
      throw new RegistryProtocolError(
        'PAGINATION_LIMIT',
        'Registry referrers pagination exceeded 100 pages',
      );
    return output.sort((left, right) =>
      compareCanonicalStrings(left.digest, right.digest),
    );
  }
}

/**
 * An index is valid when every manifest it names is a well-formed descriptor.
 *
 * Kept separate from `validateManifest` rather than loosening it: an index has
 * no config and no layers, so accepting one through the image check would mean
 * dropping the checks that make an image manifest meaningful.
 */
export function validateIndex(index: {
  schemaVersion?: number;
  mediaType?: string;
  manifests?: unknown;
}): void {
  if (index.schemaVersion !== 2 || !isIndexMediaType(index.mediaType ?? ''))
    throw new TypeError('Invalid OCI index envelope');
  if (!Array.isArray(index.manifests))
    throw new TypeError('OCI index must carry a manifests array');
  if (index.manifests.length > 1024)
    throw new TypeError('OCI index exceeds the bounded manifest count');
  for (const descriptor of index.manifests)
    validateOciDescriptor(descriptor as OciDescriptor);
}

export function validateManifest(manifest: OciManifest): void {
  if (
    manifest.schemaVersion !== 2 ||
    !isImageMediaType(manifest.mediaType as string)
  )
    throw new TypeError('Invalid OCI manifest envelope');
  validateOciDescriptor(manifest.config);
  for (const layer of manifest.layers) validateOciDescriptor(layer);
  if (manifest.subject) validateOciDescriptor(manifest.subject);
}

function validateUploadCompletion(
  response: Response,
  descriptor: OciDescriptor,
): void {
  if (response.status !== 201 && response.status !== 202)
    throw new RegistryProtocolError(
      'REGISTRY_ERROR',
      `Registry returned HTTP ${response.status} completing blob upload`,
    );
  const returned = response.headers.get('docker-content-digest');
  if (returned && returned !== descriptor.digest)
    throw new RegistryProtocolError(
      'DIGEST_MISMATCH',
      'Registry returned a different blob digest',
    );
}

function exactLengthStream(
  stream: ReadableStream<Uint8Array>,
  expectedLength: number,
): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  let size = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const item = await reader.read();
      if (item.done) {
        if (size !== expectedLength)
          controller.error(
            new RegistryProtocolError(
              'INVALID_RANGE_RESPONSE',
              `Registry returned ${size} range bytes, expected ${expectedLength}`,
            ),
          );
        else controller.close();
        return;
      }
      if (!item.value) return;
      size += item.value.byteLength;
      if (size > expectedLength) {
        await reader.cancel();
        controller.error(
          new RegistryProtocolError(
            'INVALID_RANGE_RESPONSE',
            `Registry range exceeded ${expectedLength} bytes`,
          ),
        );
        return;
      }
      controller.enqueue(item.value);
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
}

async function abortableDelay(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  if (milliseconds === 0) return;
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout);
      reject(
        signal?.reason ?? new DOMException('Operation aborted', 'AbortError'),
      );
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function validateReference(reference: string): void {
  if (
    !/^(?:[A-Za-z0-9_][A-Za-z0-9._-]{0,127}|sha256:[0-9a-f]{64})$/u.test(
      reference,
    )
  )
    throw new TypeError('Invalid OCI tag or digest reference');
}

function isCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}

function ignoreExists(error: unknown): void {
  if (!isCode(error, 'EEXIST')) throw error;
}

async function registryError(
  response: Response,
): Promise<RegistryProtocolError> {
  return new RegistryProtocolError(
    'REGISTRY_ERROR',
    `Registry returned HTTP ${response.status}: ${(await response.text()).slice(0, 1024)}`,
  );
}

export class RegistryProtocolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RegistryProtocolError';
  }
}
export * from './provider.js';
