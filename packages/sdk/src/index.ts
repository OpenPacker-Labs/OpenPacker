import { canonicalBytes, parseCanonicalJson } from '@openpacker/canonical';
import type {
  Capabilities,
  CatalogImportRequest,
  CatalogImportResponse,
  CatalogSnapshotRequest,
  CatalogSnapshotResponse,
  EnumerateRequest,
  EnumerateResponse,
  ExplainRequest,
  ExplainResponse,
  IdentifyRequest,
  IdentifyResponse,
  InspectRequest,
  InspectResponse,
  JsonValue,
  LifecycleApplyRequest,
  LifecycleApplyResponse,
  LockImportRequest,
  LockImportResponse,
  MaterializeRequest,
  MaterializeResponse,
  NormalizeRequest,
  NormalizeResponse,
  OpenPackerCloudEvent,
  PackRequest,
  PackResponse,
  Problem,
  PublishRequest,
  PublishResponse,
  ResolutionReceipt,
  SignedReceipt,
  SolveRequest,
  SolveResponse,
  SourceSnapshot,
  VerifyRequest,
  VerifyResponse,
} from '@openpacker/contracts';

export interface RequestAuthenticationInput {
  url: string;
  method: string;
  headers: Headers;
}

export interface PrexClientOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  headers?: HeadersInit;
  authenticate?: (
    input: RequestAuthenticationInput,
  ) => HeadersInit | void | Promise<HeadersInit | void>;
  retries?: number;
  timeoutMilliseconds?: number;
  maximumResponseBytes?: number;
  userAgent?: string;
}

export interface RequestOptions {
  signal?: AbortSignal;
  headers?: HeadersInit;
  timeoutMilliseconds?: number;
  correlationId?: string;
  traceparent?: string;
  tracestate?: string;
  idempotencyKey?: string;
}

export interface RawResponse<T> {
  data: T;
  rawBytes: Uint8Array;
  response: Response;
}

export interface RawEvent {
  event: OpenPackerCloudEvent;
  rawBytes: Uint8Array;
}

export interface EventFeedOptions extends RequestOptions {
  pageSize?: number;
}

export interface EventPage {
  events: RawEvent[];
  nextCursor: number;
}

export class PrexClientError extends Error {
  constructor(
    readonly status: number,
    readonly problem: Problem | undefined,
    readonly rawBytes: Uint8Array,
    readonly response: Response,
  ) {
    super(
      problem?.detail ??
        problem?.title ??
        `PREX request failed with HTTP ${status}`,
    );
    this.name = 'PrexClientError';
  }
}

export class UnsupportedProtocolVersionError extends Error {
  constructor(readonly protocolVersion: string) {
    super(`Unsupported PREX protocol version: ${protocolVersion}`);
    this.name = 'UnsupportedProtocolVersionError';
  }
}

export type ReceiptDocument = SignedReceipt | ResolutionReceipt;

const JSON_HEADERS = {
  accept: 'application/json',
  'content-type': 'application/json',
};

const DEFAULT_MAXIMUM_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAXIMUM_EVENT_PAGE_BYTES = 16 * 1024 * 1024;
const MAXIMUM_ERROR_BYTES = 1024 * 1024;

interface ControlledResponse {
  response: Response;
  signal: AbortSignal;
  dispose: () => void;
}

export class OpenPackerClient {
  readonly #baseUrl: URL;
  readonly #fetch: typeof fetch;
  readonly #headers: Headers;
  readonly #authenticate: PrexClientOptions['authenticate'];
  readonly #retries: number;
  readonly #timeoutMilliseconds: number;
  readonly #maximumResponseBytes: number;

  constructor(options: PrexClientOptions = {}) {
    this.#baseUrl = new URL(options.baseUrl ?? 'http://127.0.0.1:7337/');
    this.#fetch = options.fetch ?? globalThis.fetch;
    if (!this.#fetch)
      throw new TypeError('A standard fetch implementation is required');
    this.#headers = new Headers(options.headers);
    if (
      this.#baseUrl.protocol !== 'https:' &&
      (this.#headers.has('authorization') || options.authenticate !== undefined)
    )
      throw new TypeError(
        'Authenticated OpenPacker clients require an HTTPS base URL',
      );
    if (options.userAgent) this.#headers.set('user-agent', options.userAgent);
    this.#authenticate = options.authenticate;
    this.#retries = positiveInteger(options.retries ?? 0, 'retries', true);
    this.#timeoutMilliseconds = positiveInteger(
      options.timeoutMilliseconds ?? 30_000,
      'timeoutMilliseconds',
    );
    this.#maximumResponseBytes = positiveInteger(
      options.maximumResponseBytes ?? DEFAULT_MAXIMUM_RESPONSE_BYTES,
      'maximumResponseBytes',
    );
  }

  discovery(options?: RequestOptions): Promise<RawResponse<Capabilities>> {
    return this.#request('GET', '/.well-known/prex', undefined, options);
  }
  capabilities(options?: RequestOptions): Promise<RawResponse<Capabilities>> {
    return this.#request('GET', '/v1/capabilities', undefined, options);
  }
  health(options?: RequestOptions): Promise<RawResponse<JsonValue>> {
    return this.#request('GET', '/v1/health', undefined, options);
  }
  ready(options?: RequestOptions): Promise<RawResponse<JsonValue>> {
    return this.#request('GET', '/v1/ready', undefined, options);
  }
  normalize(
    input: NormalizeRequest,
    options?: RequestOptions,
  ): Promise<RawResponse<NormalizeResponse>> {
    return this.#request('POST', '/v1/normalize', input, options);
  }
  identify(
    input: IdentifyRequest,
    options?: RequestOptions,
  ): Promise<RawResponse<IdentifyResponse>> {
    return this.#request('POST', '/v1/identify', input, options);
  }
  enumerate(
    input: EnumerateRequest,
    options?: RequestOptions,
  ): Promise<RawResponse<EnumerateResponse>> {
    return this.#request('POST', '/v1/enumerate', input, options);
  }
  inspect(
    input: InspectRequest,
    options?: RequestOptions,
  ): Promise<RawResponse<InspectResponse>> {
    return this.#request('POST', '/v1/inspect', input, options);
  }
  solve(
    input: SolveRequest,
    options?: RequestOptions,
  ): Promise<RawResponse<SolveResponse>> {
    return this.#request('POST', '/v1/solve', input, options);
  }
  materialize(
    input: MaterializeRequest,
    options?: RequestOptions,
  ): Promise<RawResponse<MaterializeResponse>> {
    return this.#request('POST', '/v1/materialize', input, options);
  }
  verify(
    input: VerifyRequest,
    options?: RequestOptions,
  ): Promise<RawResponse<VerifyResponse>> {
    return this.#request('POST', '/v1/verify', input, options);
  }
  explain(
    input: ExplainRequest,
    options?: RequestOptions,
  ): Promise<RawResponse<ExplainResponse>> {
    return this.#request('POST', '/v1/explain', input, options);
  }
  receipt(
    algorithm: string,
    digest: string,
    options?: RequestOptions,
  ): Promise<RawResponse<ReceiptDocument>> {
    return this.#request(
      'GET',
      digestPath('receipts', algorithm, digest),
      undefined,
      options,
    );
  }
  snapshot(
    algorithm: string,
    digest: string,
    options?: RequestOptions,
  ): Promise<RawResponse<SourceSnapshot | JsonValue>> {
    return this.#request(
      'GET',
      digestPath('snapshots', algorithm, digest),
      undefined,
      options,
    );
  }

  catalogImport(
    input: CatalogImportRequest,
    options?: RequestOptions,
  ): Promise<RawResponse<CatalogImportResponse>> {
    return this.#request(
      'POST',
      '/v1/openpacker/catalog/import',
      input,
      options,
    );
  }
  catalogSnapshot(
    input: CatalogSnapshotRequest,
    options?: RequestOptions,
  ): Promise<RawResponse<CatalogSnapshotResponse>> {
    return this.#request(
      'POST',
      '/v1/openpacker/catalog/snapshot',
      input,
      options,
    );
  }
  lockImport(
    input: LockImportRequest,
    options?: RequestOptions,
  ): Promise<RawResponse<LockImportResponse>> {
    return this.#request('POST', '/v1/openpacker/lock/import', input, options);
  }
  lifecycleApply(
    input: LifecycleApplyRequest,
    options?: RequestOptions,
  ): Promise<RawResponse<LifecycleApplyResponse>> {
    return this.#request(
      'POST',
      '/v1/openpacker/lifecycle/apply',
      input,
      options,
    );
  }
  pack(
    input: PackRequest,
    options?: RequestOptions,
  ): Promise<RawResponse<PackResponse>> {
    return this.#request('POST', '/v1/openpacker/pack', input, options);
  }
  publish(
    input: PublishRequest,
    options?: RequestOptions,
  ): Promise<RawResponse<PublishResponse>> {
    return this.#request('POST', '/v1/openpacker/publish', input, options);
  }

  async *events(
    cursor = 0,
    options?: EventFeedOptions,
  ): AsyncGenerator<RawEvent> {
    const pageSize = positiveInteger(options?.pageSize ?? 1_000, 'pageSize');
    let checkpoint = positiveInteger(cursor, 'cursor', true);
    for (;;) {
      const page = await this.eventPage(checkpoint, pageSize, options);
      yield* page.events;
      if (page.events.length < pageSize || page.nextCursor <= checkpoint)
        return;
      checkpoint = page.nextCursor;
    }
  }

  async eventPage(
    cursor = 0,
    limit = 1_000,
    options?: RequestOptions,
  ): Promise<EventPage> {
    positiveInteger(cursor, 'cursor', true);
    positiveInteger(limit, 'limit');
    const headers = new Headers(options?.headers);
    headers.set('accept', 'application/x-ndjson');
    const controlled = await this.#fetchResponse(
      'GET',
      `/v1/events?cursor=${encodeURIComponent(String(cursor))}&limit=${encodeURIComponent(String(limit))}`,
      undefined,
      { ...options, headers },
    );
    const { response, signal } = controlled;
    try {
      const rawBytes = await readBoundedResponse(
        response,
        response.ok
          ? Math.min(this.#maximumResponseBytes, MAXIMUM_EVENT_PAGE_BYTES)
          : Math.min(this.#maximumResponseBytes, MAXIMUM_ERROR_BYTES),
        signal,
      );
      if (!response.ok) throw errorFromBytes(response, rawBytes);
      const text = new TextDecoder('utf-8', { fatal: true }).decode(rawBytes);
      const events = text
        .split('\n')
        .map(eventJson)
        .filter((line): line is string => line !== undefined)
        .map((line) => ({
          // SAFETY: The surrounding boundary establishes the asserted domain contract.
          event: parseCanonicalJson(line) as unknown as OpenPackerCloudEvent,
          rawBytes: new TextEncoder().encode(line),
        }));
      const rawCursor = response.headers.get('x-openpacker-next-cursor');
      if (rawCursor === null || !/^(0|[1-9][0-9]*)$/u.test(rawCursor))
        throw new TypeError('PREX event response omitted a valid next cursor');
      const nextCursor = Number(rawCursor);
      if (!Number.isSafeInteger(nextCursor))
        throw new TypeError('PREX event response next cursor is not safe');
      return { events, nextCursor };
    } finally {
      controlled.dispose();
    }
  }

  async #request<T>(
    method: string,
    path: string,
    body?: unknown,
    options?: RequestOptions,
  ): Promise<RawResponse<T>> {
    const controlled = await this.#fetchResponse(method, path, body, options);
    const { response, signal } = controlled;
    try {
      const rawBytes = await readBoundedResponse(
        response,
        response.ok
          ? this.#maximumResponseBytes
          : Math.min(this.#maximumResponseBytes, MAXIMUM_ERROR_BYTES),
        signal,
      );
      if (!response.ok) throw errorFromBytes(response, rawBytes);
      const data = parseJson<T>(rawBytes);
      assertSupportedProtocolVersion(data, response);
      return { data, rawBytes, response };
    } finally {
      controlled.dispose();
    }
  }

  async #fetchResponse(
    method: string,
    path: string,
    body?: unknown,
    options?: RequestOptions,
  ): Promise<ControlledResponse> {
    const url = new URL(path.replace(/^\//u, ''), this.#baseUrl).href;
    const attempts = 1 + this.#retries;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const headers = new Headers(this.#headers);
      for (const [key, value] of new Headers(options?.headers))
        headers.set(key, value);
      if (body !== undefined)
        for (const [key, value] of Object.entries(JSON_HEADERS))
          if (!headers.has(key)) headers.set(key, value);
      if (options?.correlationId)
        headers.set('x-correlation-id', options.correlationId);
      if (options?.traceparent) headers.set('traceparent', options.traceparent);
      if (options?.tracestate) headers.set('tracestate', options.tracestate);
      if (options?.idempotencyKey)
        headers.set('idempotency-key', options.idempotencyKey);
      const authentication = await this.#authenticate?.({
        url,
        method,
        headers: new Headers(headers),
      });
      if (authentication !== undefined)
        for (const [key, value] of new Headers(authentication))
          headers.set(key, value);
      if (
        new URL(url).protocol !== 'https:' &&
        ['authorization', 'proxy-authorization', 'cookie'].some((name) =>
          headers.has(name),
        )
      )
        throw new TypeError(
          'Credential-bearing OpenPacker requests require an HTTPS URL',
        );
      const timeout = positiveInteger(
        options?.timeoutMilliseconds ?? this.#timeoutMilliseconds,
        'timeoutMilliseconds',
      );
      const { signal, dispose } = combinedSignal(options?.signal, timeout);
      let handedOff = false;
      try {
        const requestBody =
          body === undefined
            ? undefined
            : // SAFETY: The surrounding boundary establishes the asserted domain contract.
              Uint8Array.from(
                canonicalBytes(JSON.parse(JSON.stringify(body)) as JsonValue),
              ).buffer;
        const response = await this.#fetch(url, {
          method,
          headers,
          signal,
          ...(!(requestBody === undefined) && { body: requestBody }),
        });
        if (
          !canRetry(method, options, response.status) ||
          attempt + 1 === attempts
        ) {
          handedOff = true;
          return { response, signal, dispose };
        }
        void response.body?.cancel();
      } catch (error) {
        if (
          signal.aborted ||
          attempt + 1 === attempts ||
          !canRetry(method, options)
        )
          throw error;
      } finally {
        if (!handedOff) dispose();
      }
    }
    throw new Error('Unreachable retry state');
  }
}

export function createOpenPackerClient(
  options?: PrexClientOptions,
): OpenPackerClient {
  return new OpenPackerClient(options);
}

function positiveInteger(
  value: number,
  name: string,
  allowZero = false,
): number {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1))
    throw new RangeError(
      `${name} must be ${allowZero ? 'a non-negative' : 'a positive'} safe integer`,
    );
  return value;
}

function digestPath(
  kind: 'receipts' | 'snapshots',
  algorithm: string,
  digest: string,
): string {
  if (!/^[a-z0-9]+$/u.test(algorithm) || !/^[0-9a-f]+$/u.test(digest))
    throw new TypeError(
      'Digest path components must be lowercase alphanumeric/hexadecimal',
    );
  return `/v1/${kind}/${algorithm}/${digest}`;
}

function parseJson<T>(bytes: Uint8Array): T {
  if (bytes.byteLength === 0)
    throw new SyntaxError('PREX response body is empty');
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  return JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(bytes),
  ) as T;
}

function assertSupportedProtocolVersion(
  value: unknown,
  response: Response,
): void {
  const object =
    typeof value === 'object' && value !== null
      ? // SAFETY: The surrounding boundary establishes the asserted domain contract.
        (value as Record<string, unknown>)
      : undefined;
  const meta =
    typeof object?.meta === 'object' && object.meta !== null
      ? // SAFETY: The surrounding boundary establishes the asserted domain contract.
        (object.meta as Record<string, unknown>)
      : undefined;
  const version =
    response.headers.get('prex-version') ??
    (typeof meta?.protocolVersion === 'string'
      ? meta.protocolVersion
      : typeof object?.protocolVersion === 'string'
        ? object.protocolVersion
        : undefined);
  if (version !== undefined && !/^1(?:[.-]|$)/u.test(version))
    throw new UnsupportedProtocolVersionError(version);
}

function errorFromBytes(
  response: Response,
  bytes: Uint8Array,
): PrexClientError {
  let problem: Problem | undefined;
  try {
    problem = parseJson<Problem>(bytes);
  } catch {
    /* Preserve non-JSON upstream bytes for diagnostics. */
  }
  return new PrexClientError(response.status, problem, bytes, response);
}

async function readBoundedResponse(
  response: Response,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const declaredLength = response.headers.get('content-length');
  if (
    declaredLength !== null &&
    /^(0|[1-9][0-9]*)$/u.test(declaredLength) &&
    BigInt(declaredLength) > BigInt(maximumBytes)
  ) {
    void response.body?.cancel();
    throw new RangeError(`PREX response exceeds ${maximumBytes} bytes`);
  }
  if (response.body === null) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await withAbort(reader.read(), signal);
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes)
        throw new RangeError(`PREX response exceeds ${maximumBytes} bytes`);
      chunks.push(value);
    }
  } catch (error) {
    void reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

function canRetry(
  method: string,
  options?: RequestOptions,
  status?: number,
): boolean {
  const safe = method === 'GET' || options?.idempotencyKey !== undefined;
  return (
    safe && (status === undefined || [429, 502, 503, 504].includes(status))
  );
}

function combinedSignal(
  parent: AbortSignal | undefined,
  timeoutMilliseconds: number,
) {
  const controller = new AbortController();
  const abort = () => controller.abort(parent?.reason);
  parent?.addEventListener('abort', abort, { once: true });
  if (parent?.aborted) abort();
  const timer = setTimeout(
    () =>
      controller.abort(
        new DOMException('PREX request timed out', 'TimeoutError'),
      ),
    timeoutMilliseconds,
  );
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', abort);
    },
  };
}

function eventJson(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(':')) return undefined;
  return trimmed.startsWith('data:') ? trimmed.slice(5).trimStart() : trimmed;
}
