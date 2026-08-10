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
import { assertWitShapedModule } from './bridge.js';

export interface AdapterDiscoveryConfig {
  /** Explicit in-process modules. */
  modules?: readonly AdapterModule[];
  /**
   * Package names or file URLs/paths to import. Each module must export
   * `adapterModule` or `default` as AdapterModule | AdapterModule[].
   */
  imports?: readonly string[];
  /**
   * Skip the WIT-shape check on imported modules.
   *
   * Only for hosts that validate elsewhere; the check is what stops an
   * imported module from advertising operations it cannot perform.
   */
  skipValidation?: boolean;
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
    const imported = Array.isArray(candidate) ? candidate : [candidate];
    // An imported module is the untrusted edge of the host: its Registry
    // Definition is a claim about what it can do, and nothing else has checked
    // it. Prove the claim against the exports before it can serve a purl type,
    // so a lie fails at load rather than half-way through a resolve.
    //
    // In-process `modules` are not re-checked here: the caller constructed
    // them, and some definitions (NuGet's service index) reach the network,
    // which is not something process start-up should do for its own pack.
    if (!config.skipValidation)
      for (const module of imported) {
        try {
          await assertWitShapedModule(module);
        } catch (error) {
          if (error instanceof AdapterHostError) throw error;
          throw new AdapterHostError(
            'INVALID_ADAPTER',
            `Adapter module from "${spec}" failed validation: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    out.push(...imported);
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
