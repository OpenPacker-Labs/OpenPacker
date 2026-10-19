import type { EcosystemCodec } from '@openpacker/adapter-core';
import { AdapterHostError } from '@openpacker/adapter-host';
import { OpmError } from './types.js';
import { requireAdapterRegistry } from './adapters.js';

/**
 * The codec that knows an ecosystem's version and range semantics.
 *
 * Resolved through the adapter registry — not a hardwired switch of packages.
 */
export function codecFor(ecosystem: string): EcosystemCodec {
  try {
    return requireAdapterRegistry().codecFor(ecosystem);
  } catch (error) {
    if (error instanceof AdapterHostError)
      throw new OpmError(error.code, error.message);
    throw error;
  }
}
