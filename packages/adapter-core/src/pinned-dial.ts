import type { LookupFunction } from 'node:net';
import { fetch as undiciFetch } from 'undici';

/** An address the destination policy already resolved and classified. */
export interface PinnedAddress {
  readonly address: string;
  readonly family: number;
}

function asDomFetch(value: unknown): typeof fetch {
  // SAFETY: undici's fetch is the WHATWG fetch that Node's global one is built
  // from. Its types differ only in nominal DOM classes (`Request`, `Response`);
  // every caller here passes a string or URL and reads status, headers and body.
  return value as typeof fetch;
}

/**
 * The fetch that goes with a pinned `Agent`. An `Agent` from the `undici`
 * package is only a valid `dispatcher` for that package's own `fetch`: the one
 * built into Node bundles an older undici and rejects the Agent with
 * `UND_ERR_INVALID_ARG`, so a pinned request must not use `globalThis.fetch`.
 */
export const pinnedFetch = asDomFetch(undiciFetch);

/**
 * A connect-time `lookup` that answers with the pinned address and never asks
 * DNS again, so the address that was checked is the address that is dialled.
 *
 * Node 20 and later dial with `autoSelectFamily`, which calls `lookup` with
 * `all: true` and reads an array back. The single-address form fails there
 * with `ERR_INVALID_IP_ADDRESS`, so answer in whichever shape was asked for.
 * The pin is read per call because a redirect re-pins between hops.
 */
export function pinnedLookup(
  current: () => PinnedAddress | undefined,
): LookupFunction {
  return (_hostname, options, callback) => {
    const pin = current();
    if (pin === undefined) {
      callback(new Error('No pinned address'), '', 4);
      return;
    }
    if (options.all === true) {
      callback(null, [{ address: pin.address, family: pin.family }]);
      return;
    }
    callback(null, pin.address, pin.family);
  };
}
