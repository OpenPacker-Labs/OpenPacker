import { PackslipError } from './errors.js';

export interface FetchRequest {
  /** The most bytes the body may have; a longer body is an error. */
  readonly maxBytes: number;
  readonly accept?: string;
}

export interface FetchResponse {
  readonly status: number;
  readonly bytes: Uint8Array;
  /** The URL after redirects. */
  readonly url: string;
}

/**
 * How this package reaches the network. It is an interface, not a global
 * `fetch`, because a consumer decides how to fetch: opm routes it through its
 * hardened, origin-pinned transport, tests route it to fixtures, and the
 * default below is a plain bounded client for standalone use.
 */
export interface Fetcher {
  get(url: string, request: FetchRequest): Promise<FetchResponse>;
}

export interface BoundedFetcherOptions {
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  /** Sent only to GitHub's own hosts, never to a redirect target elsewhere. */
  readonly githubToken?: string;
  readonly userAgent?: string;
  /** Allow `http://127.0.0.1` and `http://localhost`, for local test servers. */
  readonly allowLoopbackHttp?: boolean;
}

const MAX_REDIRECTS = 5;
const GITHUB_HOSTS = new Set(['api.github.com', 'github.com']);

function loopback(url: URL): boolean {
  return (
    url.hostname === '127.0.0.1' ||
    url.hostname === 'localhost' ||
    url.hostname === '[::1]'
  );
}

function assertAllowed(url: URL, options: BoundedFetcherOptions): void {
  if (url.username !== '' || url.password !== '')
    throw new PackslipError(
      'UNAVAILABLE',
      `Refusing a URL that carries credentials: ${url.origin}`,
    );
  if (url.protocol === 'https:') return;
  if (
    url.protocol === 'http:' &&
    options.allowLoopbackHttp === true &&
    loopback(url)
  )
    return;
  throw new PackslipError(
    'UNAVAILABLE',
    `Refusing to fetch over ${url.protocol} from ${url.origin}`,
  );
}

async function readBounded(
  response: Response,
  maxBytes: number,
  url: string,
): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes)
    throw new PackslipError(
      'UNAVAILABLE',
      `${url} is ${declared} bytes, over the ${maxBytes} byte limit`,
    );
  const reader = response.body?.getReader();
  if (reader === undefined) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new PackslipError(
        'UNAVAILABLE',
        `${url} is over the ${maxBytes} byte limit`,
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * A plain bounded HTTPS client: every hop is checked, redirects are followed by
 * hand so a credential never travels to another origin, and a body is cut off
 * at the limit the caller named. It is deliberately not a security boundary
 * against hostile networks — the signature and digest checks are — but it never
 * makes a download unbounded.
 */
export function createBoundedFetcher(
  options: BoundedFetcherOptions = {},
): Fetcher {
  const doFetch = options.fetch ?? globalThis.fetch;
  return {
    async get(url, request) {
      let current = new URL(url);
      for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        assertAllowed(current, options);
        const headers: Record<string, string> = {
          'user-agent': options.userAgent ?? 'opm-packslip',
          ...(request.accept !== undefined && { accept: request.accept }),
          ...(options.githubToken !== undefined &&
            GITHUB_HOSTS.has(current.hostname) && {
              authorization: `Bearer ${options.githubToken}`,
            }),
        };
        let response: Response;
        try {
          response = await doFetch(current, {
            headers,
            redirect: 'manual',
            signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
          });
        } catch (error) {
          throw new PackslipError(
            'UNAVAILABLE',
            `Could not reach ${current.origin}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          if (location === null)
            throw new PackslipError(
              'UNAVAILABLE',
              `${current.href} redirected without a location`,
            );
          await response.body?.cancel();
          current = new URL(location, current);
          continue;
        }
        const bytes =
          response.ok || response.status === 404
            ? await readBounded(response, request.maxBytes, current.href)
            : new Uint8Array();
        if (!response.ok && response.status !== 404)
          await response.body?.cancel();
        return { status: response.status, bytes, url: current.href };
      }
      throw new PackslipError(
        'UNAVAILABLE',
        `${url} redirected more than ${MAX_REDIRECTS} times`,
      );
    },
  };
}
