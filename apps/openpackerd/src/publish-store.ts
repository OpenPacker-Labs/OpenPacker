import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ArtifactIntegrityError,
  streamFromBytes,
  verifyBytes,
} from '@openpacker/artifact-model';
import { FilesystemArtifactStore } from '@openpacker/artifact-store';
import {
  canonicalBytes,
  canonicalDigest,
  parseCanonicalJson,
} from '@openpacker/canonical';
import { createPrexValidator, validateContract } from '@openpacker/conformance';
import type {
  ArtifactDescriptor,
  ArtifactLocation,
  Digest,
  JsonValue,
  LifecycleApplyRequest,
  LifecycleApplyResponse,
  LifecycleEvent,
  LifecycleState,
  PackageIdentity,
  PackageManifest,
  PublishRequest,
  PublishResponse,
  RegistryPublishRequest,
} from '@openpacker/contracts';
import {
  reduceLifecycle,
  type LifecycleAuthorityRule,
} from '@openpacker/lifecycle';
import { OperationError } from './operations.js';

export interface OperationContextLike {
  signal: AbortSignal;
  correlationId: string;
  offline: boolean;
}

export interface FilesystemPublishStoreOptions {
  root: string;
  now?: () => string;
  /** Chaos: invoked after CAS put and before version metadata is committed. */
  afterBlobBeforeCommit?: () => void | Promise<void>;
}

export interface StoredPublishRecord {
  name: string;
  version: string;
  exactPurl: string;
  manifestDigest: Digest;
  artifactDigest: Digest;
  descriptor: ArtifactDescriptor;
  location: ArtifactLocation;
  registryPublish: RegistryPublishRequest;
  events: LifecycleEvent[];
  lifecycle: LifecycleState;
}

const PUBLISH_SCHEMA =
  'https://openpacker.dev/spec/prex/v1/schemas/registry-api.schema.json#/$defs/RegistryPublishRequest';

const AUTHORITY_RULES: readonly LifecycleAuthorityRule[] = [
  {
    authority: 'registry',
    scopes: ['package', 'exact-version', 'release', 'channel', 'digest'],
    actions: [
      'published',
      'yanked',
      'deprecated',
      'quarantined',
      'revoked',
      'delisted',
      'restored',
      'promoted',
      'removed-from-channel',
      'ownership-transferred',
    ],
  },
  {
    authority: 'test-fixture',
    scopes: ['package', 'exact-version'],
    actions: ['published', 'yanked'],
  },
];

export function createFilesystemPublishStore(
  options: FilesystemPublishStoreOptions,
): FilesystemPublishStore {
  return new FilesystemPublishStore(options);
}

export class FilesystemPublishStore {
  readonly root: string;
  readonly artifacts: FilesystemArtifactStore;
  readonly #now: () => string;
  readonly #afterBlobBeforeCommit?: () => void | Promise<void>;
  readonly #validator = createPrexValidator();

  constructor(options: FilesystemPublishStoreOptions) {
    if (!isAbsolute(options.root))
      throw new OperationError(
        'INVALID_REQUEST',
        'OPENPACKER_PUBLISH_STORE must be an absolute directory',
        400,
      );
    this.root = options.root;
    this.artifacts = new FilesystemArtifactStore(options.root);
    this.#now = options.now ?? (() => new Date().toISOString());
    if (options.afterBlobBeforeCommit !== undefined)
      this.#afterBlobBeforeCommit = options.afterBlobBeforeCommit;
  }

  async publish(
    input: PublishRequest,
    context: OperationContextLike,
  ): Promise<PublishResponse> {
    this.#assertOnline(context);
    context.signal.throwIfAborted();
    const bytes = await readLocationBytes(input.location, context.signal);
    try {
      await verifyBytes(input.descriptor, bytes);
    } catch (error) {
      throw integrityError(error);
    }
    const registryPublish = await this.#registryPublishFrom(input, bytes);
    const name = registryPublish.manifest.name;
    const version = registryPublish.manifest.version;
    const existing = await this.getRecord(name, version);
    if (existing) {
      if (
        existing.artifactDigest.value === input.descriptor.digest.value &&
        existing.manifestDigest.value === registryPublish.manifestDigest.value
      )
        return { descriptor: existing.descriptor, location: existing.location };
      throw new OperationError(
        'DIGEST_MISMATCH',
        `Refusing digest-changing re-publish of ${name}@${version}`,
        409,
      );
    }
    await this.artifacts.initialize();
    await this.artifacts.putBlob(
      streamFromBytes(bytes),
      input.descriptor,
      context.signal,
    );
    const manifestBytes = canonicalBytes(
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      registryPublish.manifest as unknown as JsonValue,
    );
    await this.artifacts.putBlob(
      streamFromBytes(manifestBytes),
      descriptorFor(
        manifestBytes,
        'application/vnd.prex.package-manifest+json',
        'manifest',
      ),
      context.signal,
    );
    if (this.#afterBlobBeforeCommit) await this.#afterBlobBeforeCommit();
    const identity = packageIdentity(
      registryPublish.manifest,
      registryPublish.manifest.distributions[0]?.purlType ?? 'generic',
    );
    const published = lifecycleEvent(
      'published',
      identity,
      this.#now(),
      registryPublish.manifestDigest,
      'PUBLISHED',
    );
    const events = [published];
    const lifecycle = await this.#reduce(events, identity);
    await this.#commitRecord({
      name,
      version,
      exactPurl: identity.exactPurl ?? exactPurlOf(identity),
      manifestDigest: registryPublish.manifestDigest,
      artifactDigest: input.descriptor.digest,
      descriptor: input.descriptor,
      location: input.location,
      registryPublish,
      events,
      lifecycle,
    });
    return input;
  }

  async lifecycleApply(
    input: LifecycleApplyRequest,
    context: OperationContextLike,
  ): Promise<LifecycleApplyResponse> {
    this.#assertOnline(context);
    context.signal.throwIfAborted();
    if (input.authority !== 'registry' && input.authority !== 'test-fixture')
      throw new OperationError(
        'POLICY_DENIED',
        'Publish-store yank accepts registry-configured authority only',
        403,
      );
    if (!('canonicalPurl' in input.subject))
      throw new OperationError(
        'INVALID_REQUEST',
        'Yank requires a package identity with an exact version',
        400,
      );
    const record = await this.#recordFor(input.subject);
    if (!record)
      throw new OperationError(
        'VERSION_NOT_FOUND',
        'No published version matches this yank',
        404,
      );
    const events = [...record.events, input];
    const identity = packageIdentity(
      record.registryPublish.manifest,
      input.subject.purlType,
    );
    const reduction = await reduceLifecycle(
      events,
      {
        packagePurl: identity.canonicalPurl,
        ...(!(identity.exactPurl === undefined) && {
          exactPurl: identity.exactPurl,
        }),
        digest: record.artifactDigest,
      },
      this.#now(),
      AUTHORITY_RULES,
      new Map(events.map((event) => [event.eventId, event.authority])),
    );
    const accepted = reduction.history.find(
      (entry) => entry.event.eventId === input.eventId,
    );
    if (accepted?.accepted !== true)
      throw new OperationError(
        'LIFECYCLE_DENIED',
        accepted?.reason ?? 'Yank was not accepted',
        409,
      );
    await this.#commitRecord({
      ...record,
      events,
      lifecycle: reduction.state,
    });
    return { applied: input };
  }

  async readBlob(digest: Digest): Promise<Uint8Array> {
    const path = join(this.root, 'blobs', 'sha256', digest.value);
    let bytes: Uint8Array;
    try {
      bytes = await readFile(path);
    } catch (error) {
      if (isNotFound(error))
        throw new OperationError(
          'ARTIFACT_NOT_FOUND',
          `No blob for sha256:${digest.value}`,
          404,
        );
      throw error;
    }
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== digest.value)
      throw new OperationError(
        'DIGEST_MISMATCH',
        'Stored blob does not match its digest name',
        500,
      );
    return bytes;
  }

  async getRecord(
    name: string,
    version: string,
  ): Promise<StoredPublishRecord | undefined> {
    const path = recordPath(this.root, name, version);
    try {
      const raw = await readFile(path, 'utf8');
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      return parseCanonicalJson(raw) as unknown as StoredPublishRecord;
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  #assertOnline(context: OperationContextLike): void {
    if (context.offline)
      throw new OperationError(
        'UPSTREAM_UNAVAILABLE',
        'Publishing is disabled in offline mode',
        503,
      );
  }

  async #registryPublishFrom(
    input: PublishRequest,
    bytes: Uint8Array,
  ): Promise<RegistryPublishRequest> {
    const parsed = tryRegistryPublish(bytes);
    if (parsed) {
      this.#assertValid(parsed);
      const derived = await canonicalDigest(
        // SAFETY: The surrounding boundary establishes the asserted domain contract.
        parsed.manifest as unknown as JsonValue,
      );
      if (
        parsed.manifestDigest.algorithm !== derived.algorithm ||
        parsed.manifestDigest.value !== derived.value
      )
        throw new OperationError(
          'DIGEST_MISMATCH',
          'Stated manifestDigest does not match the canonical manifest',
          400,
        );
      return { ...parsed, manifestDigest: derived };
    }
    const name = input.location.annotations?.['openpacker.package.name'];
    const version = input.location.annotations?.['openpacker.package.version'];
    const purlType =
      input.location.annotations?.['openpacker.package.purlType'] ?? 'generic';
    if (!name || !version)
      throw new OperationError(
        'INVALID_REQUEST',
        'Publish requires package name and version annotations or a RegistryPublishRequest',
        400,
      );
    const manifest: PackageManifest = {
      packageManifestVersion: '1',
      name,
      version,
      distributions: [
        {
          purlType,
          identifier: name,
          version,
          digest: input.descriptor.digest,
          size: input.descriptor.size,
          ...(!(input.descriptor.mediaType === undefined) && {
            mediaType: input.descriptor.mediaType,
          }),
        },
      ],
    };
    const manifestDigest = await canonicalDigest(
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      manifest as unknown as JsonValue,
    );
    const request: RegistryPublishRequest = { manifest, manifestDigest };
    this.#assertValid(request);
    return request;
  }

  #assertValid(request: RegistryPublishRequest): void {
    const result = validateContract(
      PUBLISH_SCHEMA,
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      request as unknown as JsonValue,
      this.#validator,
    );
    if (!result.valid)
      throw new OperationError(
        'INVALID_REQUEST',
        `RegistryPublishRequest contract violation: ${result.errors[0]?.instancePath || '/'} ${result.errors[0]?.message ?? 'invalid value'}`,
        400,
      );
  }

  async #reduce(
    events: readonly LifecycleEvent[],
    identity: PackageIdentity,
  ): Promise<LifecycleState> {
    const reduction = await reduceLifecycle(
      events,
      {
        packagePurl: identity.canonicalPurl,
        ...(!(identity.exactPurl === undefined) && {
          exactPurl: identity.exactPurl,
        }),
      },
      this.#now(),
      AUTHORITY_RULES,
      new Map(events.map((event) => [event.eventId, event.authority])),
    );
    return reduction.state;
  }

  async #recordFor(
    subject: PackageIdentity,
  ): Promise<StoredPublishRecord | undefined> {
    if (subject.name && subject.version)
      return this.getRecord(subject.name, subject.version);
    const parsed = parseExactPurl(subject.exactPurl);
    if (parsed) return this.getRecord(parsed.name, parsed.version);
    return undefined;
  }

  async #commitRecord(record: StoredPublishRecord): Promise<void> {
    const destination = recordPath(this.root, record.name, record.version);
    await mkdir(dirname(destination), { recursive: true });
    await mkdir(join(this.root, 'tmp'), { recursive: true });
    const temporary = join(
      this.root,
      'tmp',
      `${Date.now()}-${randomBytes(12).toString('hex')}.json`,
    );
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const bytes = canonicalBytes(record as unknown as JsonValue);
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    try {
      await rename(temporary, destination);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

function recordPath(root: string, name: string, version: string): string {
  if (
    name === '' ||
    version === '' ||
    name.includes('\0') ||
    version.includes('\0')
  )
    throw new OperationError(
      'INVALID_REQUEST',
      'Package name and version must be non-empty',
      400,
    );
  return join(
    root,
    'packages',
    encodeURIComponent(name),
    `${encodeURIComponent(version)}.json`,
  );
}

async function readLocationBytes(
  location: ArtifactLocation,
  signal: AbortSignal,
): Promise<Uint8Array> {
  signal.throwIfAborted();
  if (location.transport !== 'file')
    throw new OperationError(
      'INVALID_REQUEST',
      'The reference publish store accepts file: artifact locations only',
      400,
    );
  let path: string;
  try {
    path = fileURLToPath(location.uri);
  } catch {
    throw new OperationError(
      'INVALID_REQUEST',
      'Publish location is not a file URL',
      400,
    );
  }
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile())
      throw new OperationError(
        'INVALID_REQUEST',
        'Publish location is not a regular file',
        400,
      );
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buffer.byteLength) {
      signal.throwIfAborted();
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.byteLength - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return buffer.subarray(0, offset);
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ELOOP'
    )
      throw new OperationError(
        'INVALID_REQUEST',
        'Refusing to follow a symbolic link publish location',
        400,
      );
    throw error;
  } finally {
    await handle.close();
  }
}

function tryRegistryPublish(
  bytes: Uint8Array,
): RegistryPublishRequest | undefined {
  try {
    const parsed = parseCanonicalJson(new TextDecoder().decode(bytes));
    if (!isObject(parsed) || !isObject(parsed.manifest)) return undefined;
    if (!isObject(parsed.manifestDigest)) return undefined;
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    return parsed as unknown as RegistryPublishRequest;
  } catch {
    return undefined;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function descriptorFor(
  bytes: Uint8Array,
  mediaType: string,
  nativeRole: string,
): ArtifactDescriptor {
  const value = createHash('sha256').update(bytes).digest('hex');
  return {
    descriptorId: `sha256:${value}`,
    digest: { algorithm: 'sha256', value },
    size: bytes.byteLength,
    mediaType,
    artifactType: mediaType,
    nativeRole,
    locations: [],
    referrers: [],
    externalRefs: [],
  };
}

function packageIdentity(
  manifest: PackageManifest,
  purlType: string,
): PackageIdentity {
  const encoded = manifest.name
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
  const canonicalPurl = `pkg:${purlType}/${encoded}`;
  const exact = `${canonicalPurl}@${manifest.version}`;
  return {
    canonicalPurl,
    exactPurl: exact,
    purlType,
    name: manifest.name,
    version: manifest.version,
    qualifiers: {},
    nativeCoordinates: [
      {
        ecosystem: purlType,
        coordinate: manifest.name,
        version: manifest.version,
      },
    ],
    aliases: [],
    sourceRefs: [],
    publisherRefs: [],
    externalRefs: [],
  };
}

function exactPurlOf(identity: PackageIdentity): string {
  return (
    identity.exactPurl ?? `${identity.canonicalPurl}@${identity.version ?? ''}`
  );
}

function lifecycleEvent(
  action: 'published' | 'yanked',
  subject: PackageIdentity,
  at: string,
  sourceSnapshot: Digest,
  reasonCode: string,
): LifecycleEvent {
  return {
    eventVersion: '1',
    eventId: randomUUID(),
    subject,
    action,
    effectiveAt: at,
    issuedAt: at,
    actor: { type: 'uri', value: 'urn:openpacker:openpackerd' },
    authority: 'registry',
    reasonCode,
    replacementRefs: [],
    sourceSnapshot,
    evidenceRefs: [],
    externalRefs: [],
  };
}

function parseExactPurl(
  purl: string | undefined,
): { name: string; version: string } | undefined {
  if (purl === undefined) return undefined;
  const match = purl.match(/^pkg:[A-Za-z0-9.-]+\/(.+?)@([^?#]+)$/u);
  if (!match?.[1] || !match[2]) return undefined;
  try {
    return { name: decodeURIComponent(match[1]), version: match[2] };
  } catch {
    return { name: match[1], version: match[2] };
  }
}

function integrityError(error: unknown): OperationError {
  if (error instanceof ArtifactIntegrityError)
    return new OperationError(error.code, error.message, 400);
  if (error instanceof OperationError) return error;
  return new OperationError(
    'INTERNAL_ERROR',
    error instanceof Error ? error.message : String(error),
    500,
  );
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}
