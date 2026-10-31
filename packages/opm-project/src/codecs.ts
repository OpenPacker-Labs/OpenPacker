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

/**
 * Whether an ecosystem's adapter exports a codec.
 *
 * One that does not (a delegated plugin's) cannot tell a version from a range
 * or order two releases, so the host can lock a package it serves but cannot
 * walk the package's dependencies or read a range for it.
 */
export function hasCodec(ecosystem: string): boolean {
  try {
    codecFor(ecosystem);
    return true;
  } catch (error) {
    if (error instanceof OpmError && error.code === 'UNSUPPORTED_ECOSYSTEM')
      return false;
    throw error;
  }
}
