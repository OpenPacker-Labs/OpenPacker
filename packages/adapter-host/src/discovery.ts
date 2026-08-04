/**
 * Load adapter modules from configuration — the only production path for
 * extending the host without editing core imports.
 *
 * Module sources are either:
 * - already-constructed AdapterModule objects (in-process / tests)
 * - dynamic import of a package or path that exports `adapterModule` or
 *   `default` as AdapterModule | AdapterModule[]
 */

import type { AdapterModule } from './types.js';
import { AdapterHostError } from './types.js';
import { AdapterRegistry } from './registry.js';

export interface AdapterDiscoveryConfig {
  /** Explicit in-process modules. */
  modules?: readonly AdapterModule[];
  /**
   * Package names or file URLs/paths to import. Each module must export
   * `adapterModule` or `default` as AdapterModule | AdapterModule[].
   */
  imports?: readonly string[];
}

/** Resolve modules from a discovery config (dynamic imports optional). */
export async function discoverAdapterModules(
  config: AdapterDiscoveryConfig,
): Promise<AdapterModule[]> {
  const out: AdapterModule[] = [...(config.modules ?? [])];
  for (const spec of config.imports ?? []) {
    let loaded: unknown;
    try {
      loaded = await import(spec);
    } catch (error) {
      throw new AdapterHostError(
        'ADAPTER_LOAD_FAILED',
        `Failed to import adapter module "${spec}": ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const mod = loaded as {
      adapterModule?: AdapterModule | AdapterModule[];
      default?: unknown;
    };
    let candidate: AdapterModule | AdapterModule[] | undefined =
      mod.adapterModule;
    if (!candidate && mod.default !== undefined && mod.default !== null) {
      if (Array.isArray(mod.default))
        candidate = mod.default as AdapterModule[];
      else if (typeof mod.default === 'object') {
        const def = mod.default as {
          adapterModule?: AdapterModule | AdapterModule[];
          id?: string;
          purlTypes?: readonly string[];
          registryDefinition?: AdapterModule['registryDefinition'];
        };
        if (def.adapterModule) candidate = def.adapterModule;
        else if (def.id && def.purlTypes && def.registryDefinition)
          candidate = def as AdapterModule;
      }
    }
    if (!candidate)
      throw new AdapterHostError(
        'INVALID_ADAPTER',
        `Module "${spec}" does not export adapterModule or default AdapterModule`,
      );
    if (Array.isArray(candidate)) out.push(...candidate);
    else out.push(candidate);
  }
  return out;
}

/** Build a registry from discovery config. */
export async function createRegistryFromDiscovery(
  config: AdapterDiscoveryConfig,
): Promise<AdapterRegistry> {
  const registry = new AdapterRegistry();
  registry.registerAll(await discoverAdapterModules(config));
  return registry;
}
