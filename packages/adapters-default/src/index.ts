import {
  AdapterRegistry,
  setAdapterRegistry,
  type AdapterModule,
} from '@openpacker/adapter-host';
import { defaultAdapterModules } from './modules.js';

export { defaultAdapterModules } from './modules.js';
export {
  hostInstallerDefinition,
  httpRegistryDefinition,
} from './definitions.js';

/**
 * Build a registry populated with the reference adapter set.
 *
 * This package is the distribution boundary: core depends on adapter-host and
 * optionally this pack, never on individual ecosystem packages.
 */
export function createDefaultAdapterRegistry(
  extra: readonly AdapterModule[] = [],
): AdapterRegistry {
  const registry = new AdapterRegistry();
  registry.registerAll(defaultAdapterModules());
  registry.registerAll(extra);
  return registry;
}

/** Install the default registry as the process-wide host registry. */
export function configureDefaultAdapters(
  extra: readonly AdapterModule[] = [],
): AdapterRegistry {
  const registry = createDefaultAdapterRegistry(extra);
  setAdapterRegistry(registry);
  return registry;
}
