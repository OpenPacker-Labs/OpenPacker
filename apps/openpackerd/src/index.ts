import { randomUUID } from 'node:crypto';
import Fastify, {
  type FastifyBodyParser,
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify';
import {
  canonicalBytes,
  canonicalDigest,
  formatDigest,
  parseCanonicalJson,
} from '@openpacker/canonical';
import { createPrexValidator, validateContract } from '@openpacker/conformance';
import {
  createCloudEvent,
  type Clock,
  type EventDataByType,
  type EventType,
} from '@openpacker/events';
import { schemaCatalog } from '@openpacker/contracts';
import type {
  Capabilities,
  ArtifactDescriptor,
  EnumerateRequest,
  ExplainRequest,
  IdentifyRequest,
  InspectRequest,
  JsonValue,
  LifecycleEvent,
  MaterializeRequest,
  NormalizeRequest,
  Problem,
  ProtocolMeta,
  PublishRequest,
  SolveRequest,
  VerifyRequest,
} from '@openpacker/contracts';
import {
  defaultCapabilities,
  OperationError,
  type OperationContext,
  type PrexOperations,
} from './operations.js';
import { SqliteStateStore, type OpenPackerStateStore } from './store.js';

export * from './operations.js';
export * from './reference.js';
export * from './store.js';

export interface OpenPackerDaemonOptions {
  operations: PrexOperations;
  databasePath?: string;
  store?: OpenPackerStateStore;
  meta?: ProtocolMeta;
  capabilities?: Capabilities;
  bodyLimit?: number;
  logger?: FastifyServerOptions['logger'];
  maximumTimeoutMilliseconds?: number;
  eventPageSize?: number;
  clock?: Clock;
}

export interface StartedOpenPackerDaemon {
  app: FastifyInstance;
  address: string;
  close(): Promise<void>;
}

const DEFAULT_META: ProtocolMeta = {
  protocolVersion: '1.0-draft',
  provider: {
    id: 'org.openpacker.reference',
    implementation: 'openpackerd',
    version: '0.1.0',
  },
};
const OPERATIONS_SCHEMA =
  'https://openpacker.dev/spec/prex/v1/schemas/operations.schema.json#/$defs/';
const RESOLUTION_SCHEMA =
  'https://openpacker.dev/spec/prex/v1/schemas/resolution.schema.json#/$defs/';
const EXTENSION_SCHEMA =
  'https://openpacker.dev/spec/prex/v1/schemas/extensions.schema.json#/$defs/';

export function createOpenPackerDaemon(
  options: OpenPackerDaemonOptions,
): FastifyInstance {
  const store = options.store ?? new SqliteStateStore(options.databasePath);
  const meta = options.meta ?? DEFAULT_META;
  const capabilities =
    options.capabilities ??
    options.operations.capabilities?.(meta) ??
    defaultCapabilities(meta);
  const clock = options.clock ?? { now: () => new Date().toISOString() };
  const contractValidator = createPrexValidator();
  const maximumTimeout = positiveInteger(
    options.maximumTimeoutMilliseconds ?? 120_000,
    'maximumTimeoutMilliseconds',
  );
  const eventPageSize = positiveInteger(
    options.eventPageSize ?? 1_000,
    'eventPageSize',
  );
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: positiveInteger(
      options.bodyLimit ?? capabilities.limits.requestBytes,
      'bodyLimit',
    ),
    requestTimeout: maximumTimeout,
  });

  app.removeContentTypeParser('application/json');
  const jsonParser: FastifyBodyParser<string> = (_request, body, done) => {
    try {
      done(null, parseCanonicalJson(body));
    } catch (error) {
      done(error as Error, undefined);
    }
  };
  app.addContentTypeParser(
    /^application\/(?:[a-z0-9.+-]+\+)?json$/u,
    { parseAs: 'string' },
    jsonParser,
  );

  app.addHook('onRequest', async (request) => {
    request.headers['x-correlation-id'] = correlationId(
      request.headers['x-correlation-id'],
    );
  });
  app.addHook('onClose', async () => store.close());
  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('x-correlation-id', request.headers['x-correlation-id']);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('prex-version', meta.protocolVersion);
    reply.header('x-openpacker-provider-id', meta.provider.id);
    reply.header('x-openpacker-provider-version', meta.provider.version);
    return payload;
  });

  app.get('/.well-known/prex', async (_request, reply) =>
    sendJson(reply, capabilities),
  );
  app.get('/v1/capabilities', async (_request, reply) =>
    sendJson(reply, capabilities),
  );
  app.get('/v1/health', async (_request, reply) =>
    sendJson(reply, {
      status: 'ok',
      protocolVersion: meta.protocolVersion,
      provider: meta.provider,
    }),
  );
  app.get('/v1/ready', async (_request, reply) =>
    store.ready()
      ? sendJson(reply, {
          status: 'ready',
          protocolVersion: meta.protocolVersion,
        })
      : sendProblem(
          reply,
          problem(
            'INTERNAL_ERROR',
            503,
            'Not ready',
            'The SQLite state store is unavailable',
          ),
        ),
  );

  post(
    app,
    '/v1/normalize',
    store,
    maximumTimeout,
    contractValidator,
    `${OPERATIONS_SCHEMA}NormalizeRequest`,
    `${OPERATIONS_SCHEMA}NormalizeResponse`,
    (body, context) =>
      options.operations.normalize(
        body as unknown as NormalizeRequest,
        context,
      ),
  );
  post(
    app,
    '/v1/identify',
    store,
    maximumTimeout,
    contractValidator,
    `${OPERATIONS_SCHEMA}IdentifyRequest`,
    `${OPERATIONS_SCHEMA}IdentifyResponse`,
    (body, context) =>
      options.operations.identify(body as unknown as IdentifyRequest, context),
  );
  post(
    app,
    '/v1/enumerate',
    store,
    maximumTimeout,
    contractValidator,
    `${OPERATIONS_SCHEMA}EnumerateRequest`,
    `${OPERATIONS_SCHEMA}EnumerateResponse`,
    (body, context) =>
      options.operations.enumerate(
        body as unknown as EnumerateRequest,
        context,
      ),
  );
  post(
    app,
    '/v1/inspect',
    store,
    maximumTimeout,
    contractValidator,
    `${OPERATIONS_SCHEMA}InspectRequest`,
    `${OPERATIONS_SCHEMA}InspectResponse`,
    (body, context) =>
      options.operations.inspect(body as unknown as InspectRequest, context),
  );
  post(
    app,
    '/v1/solve',
    store,
    maximumTimeout,
    contractValidator,
    `${RESOLUTION_SCHEMA}SolveRequest`,
    `${RESOLUTION_SCHEMA}SolveResponse`,
    async (body, context) => {
      const result = await options.operations.solve(
        body as unknown as SolveRequest,
        context,
      );
      await store.putReceipt(result.signedReceipt ?? result.unsignedReceipt);
      await emitEvent(
        store,
        clock,
        context,
        'org.openpacker.resolution.completed',
        formatDigestValue(result.solution.solutionDigest),
        {
          schemaVersion: '1',
          solutionDigest: result.solution.solutionDigest,
          requestDigest: result.requestDigest,
          universeDigest: result.universeDigest,
        },
      );
      const receiptDigest =
        result.signedReceipt?.receiptDigest ??
        (await canonicalDigest(result.unsignedReceipt as unknown as JsonValue));
      await emitEvent(
        store,
        clock,
        context,
        'org.openpacker.receipt.created',
        formatDigestValue(receiptDigest),
        { schemaVersion: '1', receiptDigest },
      );
      return result;
    },
  );
  post(
    app,
    '/v1/materialize',
    store,
    maximumTimeout,
    contractValidator,
    `${OPERATIONS_SCHEMA}MaterializeRequest`,
    `${OPERATIONS_SCHEMA}MaterializeResponse`,
    (body, context) =>
      options.operations.materialize(
        body as unknown as MaterializeRequest,
        context,
      ),
  );
  post(
    app,
    '/v1/verify',
    store,
    maximumTimeout,
    contractValidator,
    `${OPERATIONS_SCHEMA}VerifyRequest`,
    `${OPERATIONS_SCHEMA}VerifyResponse`,
    async (body, context) => {
      const input = body as unknown as VerifyRequest;
      const result = await options.operations.verify(input, context);
      if (result.decision === 'allow' && isArtifactSubject(input.subject))
        await emitEvent(
          store,
          clock,
          context,
          'org.openpacker.artifact.verified',
          formatDigestValue(input.subject.digest),
          { schemaVersion: '1', descriptor: input.subject },
        );
      return result;
    },
  );
  post(
    app,
    '/v1/explain',
    store,
    maximumTimeout,
    contractValidator,
    `${OPERATIONS_SCHEMA}ExplainRequest`,
    `${OPERATIONS_SCHEMA}ExplainResponse`,
    (body, context) =>
      options.operations.explain(body as unknown as ExplainRequest, context),
  );

  app.get<{ Params: { algorithm: string; digest: string } }>(
    '/v1/receipts/:algorithm/:digest',
    async (request, reply) => {
      try {
        const bytes = store.getReceipt(
          request.params.algorithm,
          request.params.digest,
        );
        return bytes
          ? sendBytes(reply, bytes)
          : sendProblem(
              reply,
              problem('PACKAGE_NOT_FOUND', 404, 'Receipt not found'),
            );
      } catch (error) {
        return handleError(reply, error);
      }
    },
  );
  app.get<{ Params: { algorithm: string; digest: string } }>(
    '/v1/snapshots/:algorithm/:digest',
    async (request, reply) => {
      try {
        const bytes = store.getSnapshot(
          request.params.algorithm,
          request.params.digest,
        );
        return bytes
          ? sendBytes(reply, bytes)
          : sendProblem(
              reply,
              problem('SNAPSHOT_NOT_FOUND', 404, 'Snapshot not found'),
            );
      } catch (error) {
        return handleError(reply, error);
      }
    },
  );
  app.get<{ Querystring: { cursor?: string; limit?: string } }>(
    '/v1/events',
    async (request, reply) => {
      try {
        const cursor = naturalNumber(request.query.cursor ?? '0', 'cursor');
        const limit = Math.min(
          positiveInteger(
            Number(request.query.limit ?? eventPageSize),
            'limit',
          ),
          eventPageSize,
        );
        const rows = store.eventsAfter(cursor, limit);
        reply.header('content-type', 'application/x-ndjson; charset=utf-8');
        reply.header(
          'x-openpacker-next-cursor',
          String(rows.at(-1)?.cursor ?? cursor),
        );
        return reply.send(
          rows.map(({ bytes }) => new TextDecoder().decode(bytes)).join('\n') +
            (rows.length ? '\n' : ''),
        );
      } catch (error) {
        return handleError(reply, error);
      }
    },
  );

  post(
    app,
    '/v1/openpacker/catalog/import',
    store,
    maximumTimeout,
    contractValidator,
    `${EXTENSION_SCHEMA}CatalogImportRequest`,
    `${EXTENSION_SCHEMA}CatalogImportResponse`,
    async (body, context) => {
      const result = await options.operations.catalogImport(
        body as unknown as import('@openpacker/contracts').CatalogImportRequest,
        context,
      );
      await emitEvent(
        store,
        clock,
        context,
        'org.openpacker.catalog.snapshot.created',
        result.snapshot.snapshotId,
        { schemaVersion: '1', snapshot: result.snapshot },
      );
      return result;
    },
  );
  post(
    app,
    '/v1/openpacker/catalog/snapshot',
    store,
    maximumTimeout,
    contractValidator,
    `${EXTENSION_SCHEMA}CatalogSnapshotRequest`,
    `${EXTENSION_SCHEMA}CatalogSnapshotResponse`,
    async (body, context) => {
      const result = await options.operations.catalogSnapshot(
        body as unknown as import('@openpacker/contracts').CatalogSnapshotRequest,
        context,
      );
      if (Array.isArray(result.snapshots))
        for (const snapshot of result.snapshots)
          await emitEvent(
            store,
            clock,
            context,
            'org.openpacker.catalog.snapshot.created',
            snapshot.snapshotId,
            { schemaVersion: '1', snapshot },
          );
      return result;
    },
  );
  post(
    app,
    '/v1/openpacker/lock/import',
    store,
    maximumTimeout,
    contractValidator,
    `${EXTENSION_SCHEMA}LockImportRequest`,
    `${EXTENSION_SCHEMA}LockImportResponse`,
    async (body, context) => {
      const result = await options.operations.lockImport(
        body as unknown as import('@openpacker/contracts').LockImportRequest,
        context,
      );
      await store.putReceipt(
        result.solveResponse.signedReceipt ??
          result.solveResponse.unsignedReceipt,
      );
      await emitEvent(
        store,
        clock,
        context,
        'org.openpacker.resolution.completed',
        formatDigestValue(result.solveResponse.solution.solutionDigest),
        {
          schemaVersion: '1',
          solutionDigest: result.solveResponse.solution.solutionDigest,
          requestDigest: result.solveResponse.requestDigest,
          universeDigest: result.solveResponse.universeDigest,
        },
      );
      return result as never;
    },
  );
  post(
    app,
    '/v1/openpacker/lifecycle/apply',
    store,
    maximumTimeout,
    contractValidator,
    `${EXTENSION_SCHEMA}LifecycleApplyRequest`,
    `${EXTENSION_SCHEMA}LifecycleApplyResponse`,
    async (body, context) => {
      const result = await options.operations.lifecycleApply(
        body as unknown as import('@openpacker/contracts').LifecycleApplyRequest,
        context,
      );
      await emitEvent(
        store,
        clock,
        context,
        'org.openpacker.lifecycle.changed',
        lifecycleSubject(result.applied),
        { schemaVersion: '1', lifecycleEvent: result.applied },
        result.applied.eventId,
      );
      return result;
    },
  );
  post(
    app,
    '/v1/openpacker/pack',
    store,
    maximumTimeout,
    contractValidator,
    `${EXTENSION_SCHEMA}PackRequest`,
    `${EXTENSION_SCHEMA}PackResponse`,
    async (body, context) => {
      const result = await options.operations.pack(
        body as unknown as import('@openpacker/contracts').PackRequest,
        context,
      );
      await emitEvent(
        store,
        clock,
        context,
        'org.openpacker.artifact.packed',
        formatDigestValue(result.artifact.digest),
        { schemaVersion: '1', descriptor: result.artifact },
      );
      return result;
    },
  );
  post(
    app,
    '/v1/openpacker/publish',
    store,
    maximumTimeout,
    contractValidator,
    `${EXTENSION_SCHEMA}PublishRequest`,
    `${EXTENSION_SCHEMA}PublishResponse`,
    async (body: PublishRequest, context) => {
      if (context.offline)
        throw new OperationError(
          'UPSTREAM_UNAVAILABLE',
          'Publishing is disabled in offline mode',
          503,
        );
      return options.operations.publish(body, context);
    },
  );

  app.setNotFoundHandler(async (_request, reply) =>
    sendProblem(reply, problem('PACKAGE_NOT_FOUND', 404, 'Route not found')),
  );
  app.setErrorHandler(async (error, _request, reply) =>
    handleError(reply, error),
  );
  return app;
}

/**
 * Hosts the reference daemon is willing to bind without an explicit override.
 *
 * The control plane is unauthenticated by design (capabilities say so). That
 * is only safe on a loopback interface. Binding `0.0.0.0` / `::` would expose
 * normalize/solve/materialize to the network with no auth — refuse that unless
 * the operator opts in with `allowRemoteBind`.
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

export function assertDaemonBindAddress(
  host: string,
  options: { allowRemoteBind?: boolean } = {},
): void {
  const normalized = host.trim().toLowerCase();
  if (normalized === '') throw new RangeError('Daemon host must not be empty');
  if (LOOPBACK_HOSTS.has(normalized)) return;
  // Node also accepts `0.0.0.0` / `::` / public addresses. Those require an
  // explicit opt-in so a mis-set OPENPACKER_HOST cannot accidentally publish
  // an unauthenticated control plane.
  if (options.allowRemoteBind === true) return;
  throw new RangeError(
    `Refusing to bind openpackerd to ${host}: the reference daemon is ` +
      `unauthenticated and only listens on loopback by default. Set ` +
      `OPENPACKER_ALLOW_REMOTE_BIND=1 (or allowRemoteBind: true) only if you ` +
      `intentionally expose it behind another auth boundary.`,
  );
}

export function assertDaemonPort(port: number): number {
  // 0 asks the OS for an ephemeral port (tests, one-shot fixtures). 1–65535
  // are ordinary binds. Anything else is a misconfiguration.
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535)
    throw new RangeError(
      `Daemon port must be an integer 0–65535 (got ${String(port)})`,
    );
  return port;
}

export async function startOpenPackerDaemon(
  options: OpenPackerDaemonOptions & {
    host?: string;
    port?: number;
    /** Permit non-loopback binds. Default false — see assertDaemonBindAddress. */
    allowRemoteBind?: boolean;
  },
): Promise<StartedOpenPackerDaemon> {
  const host = options.host ?? '127.0.0.1';
  const port = assertDaemonPort(options.port ?? 7337);
  assertDaemonBindAddress(host, {
    allowRemoteBind: options.allowRemoteBind === true,
  });
  const app = createOpenPackerDaemon(options);
  const address = await app.listen({ host, port });
  return { app, address, close: () => app.close() };
}

type Operation<Input extends JsonValue, Output extends JsonValue> = (
  body: Input,
  context: OperationContext,
) => Promise<Output>;

function post<Input extends JsonValue, Output extends JsonValue>(
  app: FastifyInstance,
  path: string,
  store: OpenPackerStateStore,
  maximumTimeout: number,
  validator: ReturnType<typeof createPrexValidator>,
  requestSchema: string,
  responseSchema: string,
  operation: Operation<Input, Output>,
): void {
  app.post(path, async (request, reply) => {
    try {
      const body = jsonBody(request.body);
      const key = header(request.headers['idempotency-key']);
      if (key && key.length > 256)
        throw new OperationError(
          'INVALID_NATIVE_COORDINATE',
          'Idempotency keys are limited to 256 characters',
          400,
        );
      // The key alone does not identify the request. Replaying the first
      // response for a *different* body would hand back a receipt for a solve
      // the caller never asked for, so the body is fingerprinted and a reused
      // key with new content is a conflict rather than a cache hit.
      const fingerprint = key
        ? formatDigest(await canonicalDigest(body))
        : undefined;
      const cached = key ? store.getIdempotent('POST', path, key) : undefined;
      if (cached) {
        if (cached.request !== fingerprint)
          throw new OperationError(
            // The PREX ErrorCode vocabulary is normative and has no
            // idempotency member; minting one is a spec change, not a daemon
            // change. INVALID_REQUEST with 409 says what happened.
            'INVALID_REQUEST',
            `Idempotency-Key "${key}" was already used for a different request body on ${path}`,
            409,
          );
        return sendBytes(reply, cached.bytes);
      }
      const requestContract = validateContract(requestSchema, body, validator);
      if (!requestContract.valid)
        throw new OperationError(
          'INVALID_REQUEST',
          `Request contract violation: ${requestContract.errors[0]?.instancePath || '/'} ${requestContract.errors[0]?.message ?? 'invalid value'}`,
          400,
        );
      const prepared = operationContext(
        request.headers,
        body,
        store,
        request.raw,
        maximumTimeout,
      );
      try {
        const result = await abortableOperation(
          operation(body as Input, prepared.context),
          prepared.context.signal,
        );
        const responseContract = validateContract(
          responseSchema,
          result,
          validator,
        );
        if (!responseContract.valid)
          throw new OperationError(
            'INTERNAL_ERROR',
            `Operation produced a response that violates its PREX contract: ${responseContract.errors[0]?.instancePath || '/'} ${responseContract.errors[0]?.message ?? 'invalid value'}`,
            500,
          );
        const bytes = canonicalBytes(result);
        if (key && fingerprint)
          store.putIdempotent('POST', path, key, fingerprint, bytes);
        return sendBytes(reply, bytes);
      } finally {
        prepared.dispose();
      }
    } catch (error) {
      return handleError(reply, error);
    }
  });
}

function operationContext(
  headers: Record<string, string | string[] | undefined>,
  body: JsonValue,
  store: OpenPackerStateStore,
  raw: { once(event: 'aborted', listener: () => void): unknown },
  maximumTimeout: number,
): { context: OperationContext; dispose: () => void } {
  const controller = new AbortController();
  raw.once('aborted', () =>
    controller.abort(new DOMException('Client disconnected', 'AbortError')),
  );
  const contextBody =
    isObject(body) && isObject(body.context) ? body.context : undefined;
  const requested =
    contextBody && typeof contextBody.timeoutMilliseconds === 'number'
      ? contextBody.timeoutMilliseconds
      : maximumTimeout;
  const timer = setTimeout(
    () =>
      controller.abort(new DOMException('Request timed out', 'TimeoutError')),
    Math.min(positiveInteger(requested, 'timeoutMilliseconds'), maximumTimeout),
  );
  const context: OperationContext = {
    signal: controller.signal,
    correlationId: correlationId(headers['x-correlation-id']),
    offline: header(headers['x-openpacker-offline']) === 'true',
    store,
    ...(header(headers.traceparent) === undefined
      ? {}
      : { traceparent: header(headers.traceparent)! }),
    ...(header(headers.tracestate) === undefined
      ? {}
      : { tracestate: header(headers.tracestate)! }),
    ...(header(headers['idempotency-key']) === undefined
      ? {}
      : { idempotencyKey: header(headers['idempotency-key'])! }),
  };
  return { context, dispose: () => clearTimeout(timer) };
}

function abortableOperation<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) return Promise.reject(cancelled(signal));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(cancelled(signal));
    signal.addEventListener('abort', abort, { once: true });
    operation
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}

function cancelled(signal: AbortSignal): OperationError {
  const timedOut =
    signal.reason instanceof DOMException &&
    signal.reason.name === 'TimeoutError';
  return new OperationError(
    'CANCELLED',
    timedOut ? 'Request timed out' : 'Request cancelled',
    timedOut ? 408 : 499,
  );
}

function jsonBody(value: unknown): JsonValue {
  if (!isObject(value))
    throw new OperationError(
      'INVALID_NATIVE_COORDINATE',
      'A JSON object request body is required',
      400,
    );
  return value as JsonValue;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sendJson(
  reply: import('fastify').FastifyReply,
  value: JsonValue | Capabilities,
): import('fastify').FastifyReply {
  return sendBytes(reply, canonicalBytes(value as JsonValue));
}

function sendBytes(
  reply: import('fastify').FastifyReply,
  bytes: Uint8Array,
): import('fastify').FastifyReply {
  reply.header('content-type', 'application/json; charset=utf-8');
  return reply.send(Buffer.from(bytes));
}

/**
 * The normative ErrorCode vocabulary, read from the shipped schema so the
 * daemon cannot drift from `spec/prex/v1`.
 */
const PREX_ERROR_CODES: ReadonlySet<string> = new Set(
  ((
    schemaCatalog[
      'https://openpacker.dev/spec/prex/v1/schemas/operations.schema.json'
    ] as { $defs?: { ErrorCode?: { enum?: readonly string[] } } } | undefined
  )?.$defs?.ErrorCode?.enum ?? []) as readonly string[],
);

function handleError(
  reply: import('fastify').FastifyReply,
  error: unknown,
): import('fastify').FastifyReply {
  if (error instanceof OperationError)
    return sendProblem(
      reply,
      problem(
        error.code,
        error.status ?? statusFor(error.code),
        titleFor(error.code),
        error.message,
      ),
    );
  if (
    error instanceof SyntaxError ||
    error instanceof TypeError ||
    error instanceof RangeError
  )
    return sendProblem(
      reply,
      problem(
        'INVALID_NATIVE_COORDINATE',
        400,
        'Invalid request',
        error.message,
      ),
    );
  const message =
    error instanceof Error ? error.message : 'Internal OpenPacker error';
  // A thrown value's `code` is only an error code if PREX says so. Node puts
  // ENOENT / SQLITE_CONSTRAINT there, and passing those through both emits a
  // Problem outside the normative enum and leaks the raw message — which for a
  // filesystem error is a local path.
  const candidate =
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
      ? error.code
      : undefined;
  const explicitCode =
    candidate !== undefined && PREX_ERROR_CODES.has(candidate)
      ? candidate
      : undefined;
  const code =
    explicitCode ??
    (message.startsWith('UNSATISFIABLE:')
      ? 'UNSATISFIABLE'
      : message.startsWith('unsupported semantics profile:')
        ? 'UNSUPPORTED_SEMANTICS_PROFILE'
        : 'INTERNAL_ERROR');
  return sendProblem(
    reply,
    problem(
      code,
      statusFor(code),
      titleFor(code),
      code === 'INTERNAL_ERROR'
        ? 'The reference service could not complete the request'
        : message,
    ),
  );
}

function sendProblem(
  reply: import('fastify').FastifyReply,
  value: Problem,
): import('fastify').FastifyReply {
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

function statusFor(code: string): number {
  if (
    [
      'PACKAGE_NOT_FOUND',
      'VERSION_NOT_FOUND',
      'SNAPSHOT_NOT_FOUND',
      'ARTIFACT_NOT_FOUND',
    ].includes(code)
  )
    return 404;
  if (
    code === 'UNSATISFIABLE' ||
    code === 'POLICY_DENIED' ||
    code === 'LIFECYCLE_DENIED'
  )
    return 409;
  if (code === 'PROVIDER_CAPABILITY_MISSING') return 501;
  if (code === 'CANCELLED') return 499;
  if (code === 'RATE_LIMITED') return 429;
  if (code === 'UPSTREAM_UNAVAILABLE') return 503;
  if (code === 'INTERNAL_ERROR') return 500;
  return 400;
}

function titleFor(code: string): string {
  return code
    .split('_')
    .map((part) => part.charAt(0) + part.slice(1).toLowerCase())
    .join(' ');
}
function header(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
function correlationId(value: string | string[] | undefined): string {
  const found = header(value);
  return found && found.length <= 256 ? found : randomUUID();
}
function naturalNumber(value: string, name: string): number {
  if (!/^(0|[1-9][0-9]*)$/u.test(value))
    throw new TypeError(`${name} must be a non-negative integer`);
  // Reject values that would lose precision as JS numbers before Number().
  // MAX_SAFE_INTEGER is 16 digits; anything longer is out of range.
  if (value.length > 16)
    throw new RangeError(`${name} exceeds the safe integer range`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    throw new RangeError(`${name} exceeds the safe integer range`);
  return parsed;
}
function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new RangeError(`${name} must be a positive safe integer`);
  return value;
}

async function emitEvent<T extends EventType>(
  store: OpenPackerStateStore,
  clock: Clock,
  context: OperationContext,
  type: T,
  subject: string,
  data: EventDataByType[T],
  occurrenceId?: string,
): Promise<void> {
  store.appendEvent(
    await createCloudEvent({
      type,
      source: 'urn:openpacker:openpackerd',
      subject,
      data,
      correlationId: context.correlationId,
      clock,
      ...(occurrenceId === undefined ? {} : { occurrenceId }),
    }),
  );
}

function isArtifactSubject(value: unknown): value is ArtifactDescriptor {
  return (
    isObject(value) &&
    typeof value.descriptorId === 'string' &&
    isObject(value.digest) &&
    typeof value.size === 'number'
  );
}

function lifecycleSubject(event: LifecycleEvent): string {
  return 'canonicalPurl' in event.subject
    ? (event.subject.exactPurl ?? event.subject.canonicalPurl)
    : formatDigest(event.subject);
}

function formatDigestValue(value: {
  algorithm: 'sha256';
  value: string;
}): string {
  return formatDigest(value);
}
