/**
 * Load adapter modules from configuration — the only production path for
 * extending the host without editing core imports.
 *
 * Only already-constructed, operator-trusted host modules enter this process.
 * Untrusted extensions use the out-of-process/WIT provider boundary.
 */

import type { AdapterModule } from './types.js';
import { AdapterHostError } from './types.js';
import { AdapterRegistry } from './registry.js';

export interface AdapterDiscoveryConfig {
  /** Explicit in-process modules. */
  modules?: readonly AdapterModule[];
  /** @deprecated Refused before import; use a WIT provider component. */
  imports?: readonly string[];
  /** @deprecated Imported JavaScript adapters are no longer supported. */
  skipValidation?: boolean;
}

/** Resolve explicitly trusted in-process host modules. */
export async function discoverAdapterModules(
  config: AdapterDiscoveryConfig,
): Promise<AdapterModule[]> {
  if ((config.imports?.length ?? 0) > 0)
    throw new AdapterHostError(
      'ADAPTER_LOAD_DISABLED',
      'JavaScript adapter imports execute before validation and are disabled; use an operator-trusted module or WIT provider component',
    );
  return [...(config.modules ?? [])];
}

/** Build a registry from discovery config. */
export async function createRegistryFromDiscovery(
  config: AdapterDiscoveryConfig,
): Promise<AdapterRegistry> {
  const registry = new AdapterRegistry();
  registry.registerAll(await discoverAdapterModules(config));
  return registry;
}
