import {
  BoundedFetchTransport,
  ProviderError,
  type HostLookup,
  type HttpTransport,
} from '@openpacker/adapter-core';
import { PackslipError, type Fetcher } from '@openpacker/packslip';

/** Where GitHub serves what a release needs, including the CDN a download redirects to. */
const GITHUB_ORIGINS = [
  'https://github.com',
  'https://api.github.com',
  'https://raw.githubusercontent.com',
  'https://objects.githubusercontent.com',
  'https://release-assets.githubusercontent.com',
];
const GITHUB_HOSTS = new Set(
  GITHUB_ORIGINS.map((origin) => new URL(origin).host),
);
const GITHUB_API = 'https://api.github.com';
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/** Per request, body included; a 64 MiB archive at a modest 0.5 MiB/s fits. */
const REQUEST_TIMEOUT_MS = 180_000;

export interface NetworkOptions {
  /** A transport to use for everything (tests, a mirror). */
  readonly transport?: HttpTransport;
  /** The `fetch` the per-request transport uses; injected in tests. */
  readonly fetch?: typeof fetch;
  /**
   * How hostnames are resolved before connecting. Production resolves through
   * DNS and classifies the answer; tests inject answers to prove a name that
   * resolves to a private address is refused without touching the network.
   */
  readonly lookup?: HostLookup;
  /**
   * The *name* of an environment variable holding a GitHub token. The token is
   * read when a request to the GitHub API is made, sent to that origin only,
   * and never logged or stored; opm keeps names, not values.
   */
  readonly githubTokenEnv?: string;
}

function mapFailure(url: string, error: Error): PackslipError {
  if (error instanceof PackslipError) return error;
  const detail =
    error instanceof ProviderError
      ? `${error.code}: ${error.message}`
      : error.message;
  return new PackslipError('UNAVAILABLE', `Could not fetch ${url}: ${detail}`);
}

/**
 * Give the packslip library a network that keeps opm's transport guarantees.
 *
 * Every URL here comes from a project name or from a signed document, so its
 * origin is not known in advance the way a registry's is. Each request gets its
 * own transport that allows that one origin — plus GitHub's own hosts when the
 * request is to GitHub, so a release download may follow GitHub's redirect to
 * its CDN — and classifies the addresses it resolves: a private or loopback
 * destination is refused and the connection is pinned to the address that was
 * checked. A vendor, however well signed, cannot aim a download at an internal
 * service.
 */
export function createNetwork(options: NetworkOptions): Fetcher {
  if (
    options.githubTokenEnv !== undefined &&
    !ENV_NAME.test(options.githubTokenEnv)
  )
    // The value is deliberately not quoted: the likeliest mistake is pasting
    // the token itself where its variable's name belongs.
    throw new PackslipError(
      'INVALID_INPUT',
      'The GitHub token setting must be the name of an environment variable, not its value',
    );
  return {
    async get(url, request) {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new PackslipError('UNAVAILABLE', `Not a URL: ${url}`);
      }
      const github = GITHUB_HOSTS.has(parsed.host);
      try {
        const transport =
          options.transport ??
          new BoundedFetchTransport({
            allowedOrigins: github ? GITHUB_ORIGINS : [parsed.origin],
            destinationPolicy: 'classify-and-pin',
            maximumBytes: request.maxBytes,
            // The limit covers the whole body, and an archive may be 64 MiB:
            // the transport's default 30 s would cut a steady 2 MiB/s link.
            timeoutMilliseconds: REQUEST_TIMEOUT_MS,
            ...(options.fetch !== undefined && { fetch: options.fetch }),
            ...(options.lookup !== undefined && { lookup: options.lookup }),
            // The transport attaches a bearer only to an origin it was told to
            // pin, from the environment variable named here, at request time.
            ...(options.githubTokenEnv !== undefined && {
              pinnedOrigins: [GITHUB_API],
              pinnedTokenEnvNames: new Map([
                [GITHUB_API, options.githubTokenEnv],
              ]),
            }),
          });
        const response = await transport.request({
          url,
          maximumBytes: request.maxBytes,
          headers: {
            ...(request.accept !== undefined && { accept: request.accept }),
          },
        });
        return {
          status: response.status,
          bytes: response.body,
          url: response.url,
        };
      } catch (error) {
        // The transport reports an HTTP error status as a thrown error. The
        // library treats a status as an answer — a 404 is "there is no signed
        // list", not "the network failed" — so a status comes back as one.
        if (
          error instanceof ProviderError &&
          error.upstreamStatus !== undefined &&
          error.upstreamStatus >= 400
        )
          return { status: error.upstreamStatus, bytes: new Uint8Array(), url };
        throw mapFailure(
          url,
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    },
  };
}
