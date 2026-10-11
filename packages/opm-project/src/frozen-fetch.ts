/**
 * Fetching the archives a lock names.
 *
 * Where a package comes from is the lock's to say, so the origins this may
 * contact are exactly the origins of the `resolved` URLs of the packages being
 * installed: no environment variable adds one, and a redirect to any other
 * host is refused by the transport. The transport is the same bounded,
 * destination-classifying one the registry reads use: a public registry may not
 * resolve to a private address, and only an origin the operator named
 * (`OPM_REGISTRY_<ECOSYSTEM>`) is pinned to be allowed to.
 */

import {
  BoundedFetchTransport,
  redactUrl,
  type HostLookup,
  type HttpTransport,
} from '@openpacker/adapter-core';
import { pinnedOriginsFor } from './registry.js';
import { OpmError } from './types.js';

/** The largest archive a frozen install will read into memory. */
export const MAXIMUM_ARCHIVE_BYTES = 256 * 1024 * 1024;

/** Time allowed for one archive, response body included. */
const ARCHIVE_TIMEOUT_MILLISECONDS = 120_000;

const ATTEMPTS = 3;

export interface FrozenFetchOptions {
  /** Replaces the network. Tests hand in a stand-in registry. */
  transport?: HttpTransport;
  fetch?: typeof fetch;
  lookup?: HostLookup;
}

/** The transport for `sources`, allowed to reach only their origins. */
export function transportForSources(
  ecosystem: string,
  sources: readonly string[],
  options: FrozenFetchOptions,
): HttpTransport {
  if (options.transport !== undefined) return options.transport;
  const origins = new Set<string>();
  for (const source of sources) {
    let origin: string;
    try {
      origin = new URL(source).origin;
    } catch {
      throw new OpmError(
        'UNSAFE_SOURCE',
        `${source} is not a URL opm can fetch`,
      );
    }
    origins.add(origin);
  }
  const allowed = [...origins].sort();
  if (allowed.length === 0)
    throw new OpmError('UNSAFE_SOURCE', 'The lock names nothing to fetch');
  let pinned: string[];
  try {
    pinned = pinnedOriginsFor(ecosystem).filter((origin) =>
      origins.has(origin),
    );
    return new BoundedFetchTransport({
      allowedOrigins: allowed,
      pinnedOrigins: pinned,
      destinationPolicy: 'classify-and-pin',
      maximumBytes: MAXIMUM_ARCHIVE_BYTES,
      timeoutMilliseconds: ARCHIVE_TIMEOUT_MILLISECONDS,
      ...(options.fetch !== undefined && { fetch: options.fetch }),
      ...(options.lookup !== undefined && { lookup: options.lookup }),
    });
  } catch (error) {
    if (error instanceof OpmError) throw error;
    throw new OpmError(
      'UNSAFE_SOURCE',
      `The lock names a source opm will not fetch from: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function retryable(error: unknown): boolean {
  if (error instanceof OpmError) return false;
  // SAFETY: provider and Node errors carry an optional string `code`.
  const code = (error as { code?: unknown }).code;
  return (
    code === undefined ||
    code === 'UPSTREAM_UNAVAILABLE' ||
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'UND_ERR_SOCKET'
  );
}

/**
 * One archive, read whole and bounded, retried when the network (and not the
 * registry's answer) failed.
 */
export async function downloadArchive(
  transport: HttpTransport,
  url: string,
  label: string,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await transport.request({
        url,
        maximumBytes: MAXIMUM_ARCHIVE_BYTES,
        ...(signal !== undefined && { signal }),
      });
      return response.body;
    } catch (error) {
      if (attempt < ATTEMPTS && retryable(error) && signal?.aborted !== true) {
        await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
        continue;
      }
      let where = url;
      try {
        where = redactUrl(new URL(url));
      } catch {
        // keep the raw text
      }
      throw new OpmError(
        'FETCH_FAILED',
        `Failed to fetch ${label} from ${where}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
}

/** Run `work` over `items` a few at a time; results keep the items' order. */
export async function mapPool<Item, Result>(
  items: readonly Item[],
  limit: number,
  work: (item: Item, index: number) => Promise<Result>,
): Promise<Result[]> {
  const results: Result[] = [];
  let next = 0;
  let failure: { error: unknown } | undefined;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (failure === undefined) {
        const index = next++;
        if (index >= items.length) return;
        try {
          results[index] = await work(items[index]!, index);
        } catch (error) {
          failure ??= { error };
        }
      }
    }),
  );
  if (failure !== undefined) throw failure.error;
  return results;
}
