/**
 * Adapter host access for opm-project.
 *
 * Concrete ecosystems are never imported here. Process entry points (CLI,
 * daemon, tests) register modules via `setAdapterRegistry` or a distribution
 * pack such as `@openpacker/adapters-default`.
 */

import {
  AdapterRegistry,
  getAdapterRegistry,
  setAdapterRegistry,
  tryGetAdapterRegistry,
  type AdapterModule,
} from '@openpacker/adapter-host';
import { OpmError } from './types.js';

export {
  AdapterRegistry,
  getAdapterRegistry,
  setAdapterRegistry,
  tryGetAdapterRegistry,
  type AdapterModule,
};

/**
 * Return the configured registry.
 *
 * Does not install defaults — that would re-bake ecosystems into the library.
 */
export function requireAdapterRegistry(): AdapterRegistry {
  const existing = tryGetAdapterRegistry();
  if (existing) return existing;
  throw new OpmError(
    'ADAPTER_REGISTRY_UNCONFIGURED',
    'No adapter registry is configured. Register adapters at process entry ' +
      '(for example configureDefaultAdapters() from @openpacker/adapters-default) ' +
      'before resolving codecs, catalogs, or installers.',
  );
}

/**
 * Configure the process-wide registry from explicit modules (tests / custom hosts).
 */
export function configureAdapters(
  modules: readonly AdapterModule[],
): AdapterRegistry {
  const registry = new AdapterRegistry();
  registry.registerAll(modules);
  setAdapterRegistry(registry);
  return registry;
}

/**
 * Return the configured registry, or throw if none is set.
 *
 * Name retained for CLI call sites; it never auto-loads ecosystem packages.
 */
export function ensureAdapterRegistry(): AdapterRegistry {
  return requireAdapterRegistry();
}
