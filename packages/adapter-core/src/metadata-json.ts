/**
 * Reading a registry's JSON document: decoded as UTF-8, parsed by the canonical
 * parser under the limits the caller states, and refused as a provider error.
 */
import {
  CanonicalJsonLimitError,
  parseCanonicalJsonCosted,
} from '@openpacker/canonical';
import { MetadataLimitError } from './document-refusal.js';
import { ProviderError, providerErrorForStatus } from './provider-error.js';

export interface HttpResponse {
  status: number;
  headers: Readonly<Record<string, string>>;
  body: Uint8Array;
  url: string;
}

export function text(response: HttpResponse): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(response.body);
}

/** How deep, and how many values, a metadata document may hold by default. */
const DEFAULT_MAXIMUM_DEPTH = 64;
const DEFAULT_MAXIMUM_VALUES = 200_000;

/**
 * What a metadata document may cost by default, in the units of
 * `PARSE_COSTS.peak`: 256 MiB. A count of values alone does not bound memory
 * (an object whose members are named by array indices can make an elements
 * store of 40 KB), and the cost follows what a tree allocates and is at least
 * what its parse needs. 256 MiB is above what 200,000 values of an ordinary
 * document cost (66,000 objects `{"a":1}` cost 26 MB), and with the text of a
 * 64 MiB document in two-byte characters and the process it fits a heap of
 * 1 GiB with half of it to spare (ADR 0044).
 */
export const DEFAULT_METADATA_PARSE_COST = 256 * 1024 * 1024;

/**
 * The shape a metadata document may have once parsed. The defaults suit the
 * small documents most registries serve: 200,000 values, 64 deep, and a cost
 * of `DEFAULT_METADATA_PARSE_COST`. A registry whose documents are
 * legitimately large (an npm packument lists every version ever published)
 * states its own cost, derived from the byte limit it reads under and what its
 * real documents cost to hold. A count of values cannot say what a tree costs:
 * `{},` is three bytes and an object that takes about 200 of memory, `1,` is
 * two bytes and a slot. With `maximumCost` the count is not applied unless
 * `maximumNodes` is also given.
 */
export interface ProviderMetadataLimits {
  maximumDepth?: number;
  maximumNodes?: number;
  /** The most the parsed tree may cost, in estimated bytes of heap. */
  maximumCost?: number;
}

/**
 * The largest metadata document any adapter reads, in bytes, and so the
 * largest one a resolve keeps in memory to read once. An adapter's own bound
 * may be lower; none may be higher, or the resolve stops keeping what it reads
 * and fetches it again. Artifact downloads have their own, larger bound.
 */
export const MAXIMUM_METADATA_BYTES = 64 * 1024 * 1024;

/**
 * `json`, and what the tree cost to build (`cost`, in the units of
 * `maximumCost`) and what it keeps (`retained`, in bytes of heap), for a holder
 * that keeps it.
 */
export function jsonWithCost<T>(
  response: HttpResponse,
  limits: ProviderMetadataLimits = {},
): { value: T; cost: number; retained: number } {
  if (response.status < 200 || response.status >= 300)
    throw providerErrorForStatus(response.status);
  // Decoding is inside the try: a body that is not UTF-8 is a refused document
  // like any other, and `text` throws a bare TypeError for it.
  let document = '';
  try {
    document = text(response);
    // The limits stop the parse itself: counting values after the tree is built
    // spends the memory the limit exists to protect.
    const counted = !(limits.maximumNodes === undefined)
      ? limits.maximumNodes
      : limits.maximumCost === undefined
        ? DEFAULT_MAXIMUM_VALUES
        : undefined;
    return parseCanonicalJsonCosted<T>(document, {
      ...(!(counted === undefined) && { maximumValues: counted }),
      maximumCost: limits.maximumCost ?? DEFAULT_METADATA_PARSE_COST,
      maximumDepth: limits.maximumDepth ?? DEFAULT_MAXIMUM_DEPTH,
    });
  } catch (error) {
    if (error instanceof CanonicalJsonLimitError)
      throw new MetadataLimitError(
        error.limit,
        error.maximum,
        error.visited,
        error.offset,
        document.length,
        undefined,
        error.spent,
      );
    throw new ProviderError(
      'INVALID_PROVIDER_METADATA',
      error instanceof Error ? error.message : 'Invalid JSON',
    );
  }
}

export function json<T>(
  response: HttpResponse,
  limits: ProviderMetadataLimits = {},
): T {
  return jsonWithCost<T>(response, limits).value;
}

export function assertBoundedProviderMetadata(
  value: unknown,
  maximumDepth = DEFAULT_MAXIMUM_DEPTH,
  maximumNodes = DEFAULT_MAXIMUM_VALUES,
): void {
  const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    nodes += 1;
    if (nodes > maximumNodes)
      throw new ProviderError(
        'UPSTREAM_RESPONSE_TOO_LARGE',
        `Provider metadata exceeds ${maximumNodes} values`,
      );
    if (current.depth > maximumDepth)
      throw new ProviderError(
        'INVALID_PROVIDER_METADATA',
        `Provider metadata exceeds depth ${maximumDepth}`,
      );
    if (current.value !== null && typeof current.value === 'object') {
      for (const child of Array.isArray(current.value)
        ? current.value
        : Object.values(current.value))
        pending.push({ value: child, depth: current.depth + 1 });
    }
  }
}
