/**
 * A PREX registry.
 *
 * Serves the registry HTTP binding (`spec/prex/v1/registry-api.md`): a service
 * index at a well-known path, package manifests, versions, cursor-paginated
 * listing with `updatedSince` for mirrors, and signed publish.
 *
 * Unlike `openpackerd`, this is *meant* to be reachable. The control plane is
 * unauthenticated and binds loopback by design; a registry that nobody can
 * reach is not a registry. So the default inverts — it binds where it is told,
 * and instead refuses to start with publishing open to anyone unless an
 * operator says so out loud.
 */

import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import {
  canonicalBytes,
  canonicalDigest,
  formatDigest,
  parseCanonicalJson,
} from '@openpacker/canonical';
import type {
  Digest,
  JsonValue,
  PackageManifest,
  Problem,
  RegistryEntry,
} from '@openpacker/contracts';
import { Ed25519Signer, Ed25519Verifier } from '@openpacker/trust';
import {
  RegistryStore,
  RegistryStoreError,
  type StoredEntry,
} from './store.js';

export const WELL_KNOWN = '/.well-known/prex-registry';
const DEFAULT_LIMIT = 50;
const MAXIMUM_LIMIT = 250;

export interface RegistryOptions {
  registryId: string;
  displayName?: string;
  /** Purl types this registry serves. Advertised in the service index. */
  purlTypes: readonly string[];
  store?: RegistryStore;
  databasePath?: string;
  clock?: { now: () => string };
  /**
   * Signing key. When present the registry counter-signs what it accepts, so a
   * mirror can verify rather than trust. Absent means it stores what it is
   * given and offers nothing of its own to check.
   */
  signer?: Ed25519Signer;
  /** Public keys by id, for verifying publisher signatures. */
  publisherKeys?: Readonly<Record<string, JsonWebKey>>;
  /**
   * Accept publishes with no signature and no namespace proof.
   *
   * Off by default and named plainly: a registry in this mode is the only
   * thing any consumer can check, which is a decision an operator should make
   * deliberately rather than inherit.
   */
  anonymousPublish?: boolean;
  logger?: boolean;
  bodyLimit?: number;
}

export function createRegistry(options: RegistryOptions): FastifyInstance {
  const store = options.store ?? new RegistryStore(options.databasePath);
  const clock = options.clock ?? { now: () => new Date().toISOString() };
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: options.bodyLimit ?? 4 * 1024 * 1024,
  });

  // Canonical JSON only, matching openpackerd: a document whose digest is the
  // thing under signature cannot be read by a parser that accepts duplicate
  // keys and silently keeps one.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser(
    /^application\/(?:[a-z0-9.+-]+\+)?json$/u,
    { parseAs: 'string' },
    (_request, body, done) => {
      try {
        done(null, parseCanonicalJson(body as string));
      } catch (error) {
        done(error as Error, undefined);
      }
    },
  );

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-openpacker-registry-id', options.registryId);
    return payload;
  });

  const advertised = [
    'prex.registry.search/1',
    'prex.registry.enumerate-versions/1',
    'prex.registry.package-manifest/1',
    'prex.registry.sync/1',
    'prex.registry.publish/1',
  ];

  app.get(WELL_KNOWN, async (_request, reply) =>
    sendJson(reply, {
      registryDefinitionVersion: '1',
      registryId: options.registryId,
      ...(options.displayName === undefined
        ? {}
        : { displayName: options.displayName }),
      purlTypes: [...options.purlTypes],
      protocol: { native: 'prex-registry-v1', transport: ['https'] },
      resources: [{ '@id': '/v1', '@type': advertised }],
      // No prex.registry.artifact/1: this serves metadata, and its manifests'
      // locations point upstream. Advertising it would promise bytes.
      features: {
        offlineReplay: false,
        installSideEffects: 'none',
        reversibility: 'none',
        requiresElevation: 'never',
      },
    } as unknown as JsonValue),
  );

  app.get('/v1/health', async (_request, reply) =>
    sendJson(reply, { status: store.ready() ? 'ok' : 'unavailable' }),
  );

  app.get<{
    Querystring: {
      search?: string;
      purlType?: string;
      updatedSince?: string;
      limit?: string;
      cursor?: string;
    };
  }>('/v1/packages', async (request, reply) => {
    try {
      const limit = boundedLimit(request.query.limit);
      const after = decodeCursor(request.query.cursor);
      const { entries, hasMore } = store.list({
        limit,
        ...(request.query.search === undefined
          ? {}
          : { search: request.query.search }),
        ...(request.query.purlType === undefined
          ? {}
          : { purlType: request.query.purlType }),
        ...(request.query.updatedSince === undefined
          ? {}
          : { updatedSince: assertTimestamp(request.query.updatedSince) }),
        ...(after === undefined ? {} : { afterSequence: after }),
      });
      // The cursor is the last row *read*, not the last row returned: purlType
      // filtering happens after the page is taken, and using the filtered tail
      // would replay rows that were already skipped.
      const lastRead = entries.at(-1)?.sequence ?? after;
      return sendJson(reply, {
        packages: entries.map((entry) => toRegistryEntry(entry, options)),
        metadata: {
          count: entries.length,
          nextCursor:
            hasMore && lastRead !== undefined ? encodeCursor(lastRead) : null,
        },
      } as unknown as JsonValue);
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get<{ Params: { name: string } }>(
    '/v1/packages/:name/versions',
    async (request, reply) => {
      const name = decodeURIComponent(request.params.name);
      const versions = store.versions(name);
      if (versions.length === 0)
        return sendProblem(
          reply,
          problem('PACKAGE_NOT_FOUND', 404, `No package named ${name}`),
        );
      return sendJson(reply, {
        name,
        versions: versions.map((entry) => ({
          version: entry.version,
          status: entry.status,
          isLatest: entry.isLatest,
          publishedAt: entry.publishedAt,
        })),
      } as unknown as JsonValue);
    },
  );

  app.get<{ Params: { name: string; version: string } }>(
    '/v1/packages/:name/versions/:version',
    async (request, reply) => {
      const name = decodeURIComponent(request.params.name);
      const version = decodeURIComponent(request.params.version);
      // Withdrawn versions stay retrievable by exact version: a consumer
      // holding a lockfile needs to learn a version was pulled, and a 404
      // tells it nothing.
      const entry = store.get(name, version);
      if (!entry)
        return sendProblem(
          reply,
          problem('VERSION_NOT_FOUND', 404, `${name}@${version} is not here`),
        );
      return sendJson(
        reply,
        toRegistryEntry(entry, options) as unknown as JsonValue,
      );
    },
  );

  app.post('/v1/publish', async (request, reply) => {
    try {
      const body = request.body as {
        manifest?: PackageManifest;
        manifestDigest?: Digest;
        signatures?: {
          algorithm: string;
          keyId: string;
          signature: string;
          role?: string;
        }[];
        namespaceProof?: { namespace: string; keyId: string; method: string };
      };
      if (!body?.manifest)
        throw new PublishError(
          'INVALID_REQUEST',
          400,
          'A manifest is required',
        );

      // Re-derive rather than trust. A caller-supplied digest is a claim about
      // bytes the registry is holding, and it is holding them.
      const digest = await canonicalDigest(
        body.manifest as unknown as JsonValue,
      );
      if (
        body.manifestDigest &&
        (body.manifestDigest.algorithm !== digest.algorithm ||
          body.manifestDigest.value !== digest.value)
      )
        throw new PublishError(
          'DIGEST_MISMATCH',
          400,
          `Stated ${formatDigest(body.manifestDigest)} but the manifest hashes to ${formatDigest(digest)}`,
        );

      const signatures = body.signatures ?? [];
      if (signatures.length === 0 && options.anonymousPublish !== true)
        throw new PublishError(
          'INVALID_SIGNATURE',
          401,
          'This registry requires a signed manifest. Start it with ' +
            'anonymousPublish only if you accept being the only thing anyone can check.',
        );

      const message = new TextEncoder().encode(formatDigest(digest));
      for (const signature of signatures) {
        const jwk = options.publisherKeys?.[signature.keyId];
        if (!jwk)
          throw new PublishError(
            'INVALID_SIGNATURE',
            403,
            `Key ${signature.keyId} is not known to this registry`,
          );
        const verifier = await Ed25519Verifier.fromJwk(signature.keyId, jwk);
        if (!(await verifier.verify(message, signature.signature)))
          throw new PublishError(
            'INVALID_SIGNATURE',
            400,
            `Signature from ${signature.keyId} does not verify`,
          );
      }

      // A valid signature says the document was not altered. It says nothing
      // about who may use this name, which is a separate question.
      if (signatures.length > 0)
        assertNamespace(
          store,
          body.manifest.name,
          signatures,
          body.namespaceProof,
        );

      const stored = store.publish({
        manifest: body.manifest,
        manifestDigest: formatDigest(digest),
        signatures: await counterSign(signatures, message, options.signer),
        now: clock.now(),
      });
      reply.code(stored.created ? 201 : 200);
      return sendJson(reply, {
        entry: toRegistryEntry(stored.entry, options),
      } as unknown as JsonValue);
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.patch<{ Params: { name: string; version: string } }>(
    '/v1/packages/:name/versions/:version/status',
    async (request, reply) => {
      try {
        const body = request.body as { status?: string };
        if (
          body?.status !== 'active' &&
          body?.status !== 'deprecated' &&
          body?.status !== 'deleted'
        )
          throw new PublishError(
            'INVALID_REQUEST',
            400,
            'status must be active, deprecated, or deleted',
          );
        const entry = store.setStatus(
          decodeURIComponent(request.params.name),
          decodeURIComponent(request.params.version),
          body.status,
          clock.now(),
        );
        return sendJson(
          reply,
          toRegistryEntry(entry, options) as unknown as JsonValue,
        );
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.setNotFoundHandler(async (_request, reply) =>
    sendProblem(reply, problem('PACKAGE_NOT_FOUND', 404, 'Route not found')),
  );
  app.addHook('onClose', async () => store.close());
  return app;
}

/** Counter-sign what the registry accepted, as a distinct claim. */
async function counterSign(
  signatures: readonly {
    algorithm: string;
    keyId: string;
    signature: string;
    role?: string;
  }[],
  message: Uint8Array,
  signer?: Ed25519Signer,
): Promise<readonly unknown[]> {
  const publisher = signatures.map((signature) => ({
    ...signature,
    role: signature.role ?? 'publisher',
  }));
  if (!signer) return publisher;
  return [
    ...publisher,
    {
      algorithm: signer.algorithm,
      keyId: signer.keyId,
      signature: await signer.sign(message),
      // "I accepted this" is a different claim from "I wrote this".
      role: 'registry',
    },
  ];
}

/**
 * A signing key may publish under this name.
 *
 * The namespace is the leading dotted segments of the package name, so
 * `com.example.tool` is governed by `com.example`. A key bound to no namespace
 * governs nothing.
 */
function assertNamespace(
  store: RegistryStore,
  packageName: string,
  signatures: readonly { keyId: string }[],
  proof?: { namespace: string; keyId: string; method: string },
): void {
  if (proof) store.trustKey(proof.namespace, proof.keyId, proof.method);
  const candidates = namespacesOf(packageName);
  for (const namespace of candidates) {
    const permitted = new Set(store.keysFor(namespace));
    if (signatures.some((signature) => permitted.has(signature.keyId))) return;
  }
  throw new PublishError(
    'POLICY_DENIED',
    403,
    `No signing key on this request is permitted to publish "${packageName}". ` +
      `Provide a namespace proof for one of: ${candidates.join(', ') || '(none)'}.`,
  );
}

/** `com.example.tool` → `com.example.tool`, `com.example`, `com`. */
function namespacesOf(name: string): string[] {
  const parts = name.split('.');
  const out: string[] = [];
  for (let index = parts.length; index > 0; index -= 1)
    out.push(parts.slice(0, index).join('.'));
  return out;
}

function toRegistryEntry(
  entry: StoredEntry,
  options: RegistryOptions,
): RegistryEntry {
  const [algorithm, value] = entry.manifestDigest.split(':');
  return {
    manifest: entry.manifest,
    registryMetadata: {
      registryId: options.registryId,
      ...(entry.sourceId === undefined ? {} : { sourceId: entry.sourceId }),
      status: entry.status,
      publishedAt: entry.publishedAt,
      updatedAt: entry.updatedAt,
      isLatest: entry.isLatest,
      manifestDigest: { algorithm, value } as Digest,
    },
    ...(entry.signatures.length > 0
      ? { signatures: entry.signatures as never }
      : {}),
  } as RegistryEntry;
}

/**
 * Cursors are opaque to clients and carry the last sequence read.
 *
 * Base64 rather than a bare number so nobody builds on the encoding — a client
 * that arithmetics on a cursor has coupled itself to this implementation.
 */
function encodeCursor(sequence: number): string {
  return Buffer.from(`seq:${sequence}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor?: string): number | undefined {
  if (cursor === undefined || cursor === '') return undefined;
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const match = /^seq:(\d+)$/u.exec(decoded);
  if (!match)
    throw new PublishError(
      'INVALID_REQUEST',
      400,
      'Malformed pagination cursor',
    );
  return Number(match[1]);
}

function boundedLimit(value?: string): number {
  if (value === undefined) return DEFAULT_LIMIT;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw new PublishError(
      'INVALID_REQUEST',
      400,
      'limit must be a positive integer',
    );
  return Math.min(parsed, MAXIMUM_LIMIT);
}

function assertTimestamp(value: string): string {
  if (Number.isNaN(Date.parse(value)))
    throw new PublishError(
      'INVALID_REQUEST',
      400,
      'updatedSince must be an RFC 3339 timestamp',
    );
  return value;
}

class PublishError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'PublishError';
  }
}

function fail(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof PublishError)
    return sendProblem(
      reply,
      problem(
        error.code,
        error.status,
        'Registry request failed',
        error.message,
      ),
    );
  if (error instanceof RegistryStoreError)
    return sendProblem(
      reply,
      problem(
        error.code === 'VERSION_EXISTS'
          ? 'SNAPSHOT_MISMATCH'
          : 'PACKAGE_NOT_FOUND',
        error.code === 'VERSION_EXISTS' ? 409 : 404,
        'Registry request failed',
        error.message,
      ),
    );
  // Nothing else reaches a caller: an internal message is a local path or a
  // query as often as it is useful.
  return sendProblem(
    reply,
    problem(
      'INTERNAL_ERROR',
      500,
      'The registry could not complete the request',
    ),
  );
}

function sendJson(reply: FastifyReply, value: JsonValue): FastifyReply {
  reply.header('content-type', 'application/json; charset=utf-8');
  return reply.send(Buffer.from(canonicalBytes(value)));
}

function sendProblem(reply: FastifyReply, value: Problem): FastifyReply {
  reply
    .code(value.status)
    .header('content-type', 'application/problem+json; charset=utf-8');
  return reply.send(Buffer.from(canonicalBytes(value as unknown as JsonValue)));
}

function problem(
  code: string,
  status: number,
  title: string,
  detail?: string,
): Problem {
  return {
    type: `https://openpacker.dev/problems/${code.toLowerCase().replaceAll('_', '-')}`,
    title,
    status,
    ...(detail === undefined ? {} : { detail }),
    code: code as Problem['code'],
    retryable: [429, 502, 503, 504].includes(status),
  };
}

export { RegistryStore } from './store.js';
