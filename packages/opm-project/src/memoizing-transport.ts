import { createHash } from 'node:crypto';
import { parseUntrustedUrl } from '@openpacker/canonical';
import {
  DEFAULT_RETAINED_BYTES,
  MAXIMUM_METADATA_BYTES,
  ProviderError,
  RetentionLedger,
  echoed,
  redactUrl,
  type HttpRequest,
  type HttpResponse,
  type HttpTransport,
} from '@openpacker/adapter-core';

function etagOf(response: HttpResponse): string | undefined {
  for (const [name, value] of Object.entries(response.headers))
    if (name.toLowerCase() === 'etag') return value;
  return undefined;
}

const digestOf = (body: Uint8Array): string =>
  createHash('sha256').update(body).digest('hex');

/** The document's address for a message: no credentials, no query, one line. */
function shown(url: string): string {
  try {
    return echoed(redactUrl(parseUntrustedUrl(url)));
  } catch {
    return 'a registry document';
  }
}

export interface MemoizingOptions {
  /**
   * What the resolve may keep of the documents it has read, in bytes: the text
   * of a document, and what a holder reports of the objects parsed from it
   * (`retention`). Over it, the least recently used are let go and fetched
   * again if they are needed. Default 256 MiB; `Infinity` keeps everything.
   * It has no effect on a transport that is not `refetchable`, which is kept
   * whole because what is let go could not be had again.
   */
  readonly maximumRetainedBytes?: number;
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
 * Only repeatable metadata reads are kept: a GET, bounded to no more than the
 * largest metadata document an adapter reads, that is not an artifact download.
 * Artifact bytes pass through and are not held. Every request, kept or not,
 * takes one of a fixed number of slots, so a walk that reads ahead cannot open
 * a connection per package.
 *
 * `ENTRY_LIMIT` is the adapters' own ceiling and not a number of this class's:
 * a request is kept only if it asks for no more than that, so an adapter that
 * is allowed a bigger document than this keeps would be fetched again at every
 * use (npm's `next` packument is 25.6 MB).
 *
 * What is kept is bounded, and the bound is the ledger in `retention`: a
 * document is held at its length, the provider holds the objects it parsed
 * from one at what the parse cost, and both go when they are the least
 * recently used over the budget. A document let go is fetched again through the
 * same transport the next time it is asked for, and the fetch is compared with
 * a digest taken as it went: a resolve never reads two different documents under
 * one name, it stops. Nothing is let go of a transport that does not say it can
 * be asked again (`refetchable`).
 */
export class MemoizingTransport implements HttpTransport {
  static readonly ENTRY_LIMIT = MAXIMUM_METADATA_BYTES;
  static readonly CONCURRENCY = 12;
  static readonly DEFAULT_RETAINED_BYTES = DEFAULT_RETAINED_BYTES;
  readonly refetchable: boolean;
  /** Where the resolve's holders say what they keep. */
  readonly retention: RetentionLedger;
  readonly #inner: HttpTransport;
  readonly #kept = new Map<string, Promise<HttpResponse>>();
  /** The digest of each document let go, so its second reading is checked. */
  readonly #letGo = new Map<string, string>();
  readonly #waiting: (() => void)[] = [];
  #active = 0;
  #fetches = 0;

  constructor(inner: HttpTransport, options: MemoizingOptions = {}) {
    this.#inner = inner;
    this.refetchable = inner.refetchable === true;
    this.retention = new RetentionLedger(
      this.refetchable
        ? (options.maximumRetainedBytes ?? DEFAULT_RETAINED_BYTES)
        : Number.POSITIVE_INFINITY,
    );
  }

  /** How many requests reached the transport underneath. */
  get fetches(): number {
    return this.#fetches;
  }

  async request(request: HttpRequest): Promise<HttpResponse> {
    if (!MemoizingTransport.repeatable(request)) return this.slot(request);
    const key = `${request.url}\n${request.headers?.accept ?? ''}`;
    const existing = this.#kept.get(key);
    if (existing === undefined) {
      const fetched: Promise<HttpResponse> = this.slot(request).then(
        (response) => {
          if (
            response.status !== 200 ||
            response.body.byteLength > MemoizingTransport.ENTRY_LIMIT
          ) {
            this.#kept.delete(key);
            return response;
          }
          this.checkAgainstWhatWasLetGo(key, request.url, response);
          this.retention.retain(
            this.ledgerKey(key),
            response.body.byteLength,
            () => {
              // Only this fetch's own entry: a newer one may have replaced it.
              if (this.#kept.get(key) !== fetched) return;
              this.#kept.delete(key);
              this.#letGo.set(key, digestOf(response.body));
            },
            {
              // A provider that keeps the objects parsed from this body keeps
              // the body too: the two are one entry, counted once and let go
              // together, and while the provider holds them this answers its
              // revalidations from memory.
              shares: response.body,
              // Let go before the provider held it, it comes back at no cost
              // when the provider does, unless this has fetched it again since.
              reclaim: () => {
                if (this.#kept.has(key)) return false;
                this.#kept.set(key, fetched);
                this.#letGo.delete(key);
                return true;
              },
            },
          );
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
    this.retention.touch(this.ledgerKey(key));
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

  private ledgerKey(key: string): string {
    return `memo\n${key}`;
  }

  /** A document read again must be the document that was let go. */
  private checkAgainstWhatWasLetGo(
    key: string,
    url: string,
    response: HttpResponse,
  ): void {
    const before = this.#letGo.get(key);
    if (before === undefined) return;
    if (digestOf(response.body) !== before) {
      this.#kept.delete(key);
      throw new ProviderError(
        'STALE_METADATA',
        `The registry changed ${shown(url)} during the resolve; run it again`,
      );
    }
    this.#letGo.delete(key);
  }

  /** Run `request` in one of the fixed number of slots. */
  private async slot(request: HttpRequest): Promise<HttpResponse> {
    if (this.#active < MemoizingTransport.CONCURRENCY) this.#active += 1;
    else await new Promise<void>((resolve) => this.#waiting.push(resolve));
    try {
      this.#fetches += 1;
      return await this.#inner.request(request);
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
