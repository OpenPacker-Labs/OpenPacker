import type {
  CatalogProvider,
  EcosystemCodec,
  InstallerProvider,
  ProjectFormat,
} from '@openpacker/adapter-core';
import type {
  AdapterContext,
  AdapterModule,
  RegistryDefinition,
} from './types.js';
import { AdapterHostError } from './types.js';
import { hasResource, requireResource } from './resources.js';

/**
 * Production path for codecs, catalogs, and installers.
 *
 * Modules register by id and purl type; the host never switches on npm/apt/…
 * by name. Configuration supplies the module list (see adapters-default).
 */
export class AdapterRegistry {
  readonly #byId = new Map<string, AdapterModule>();
  readonly #byPurlType = new Map<string, AdapterModule>();

  /** Register a module. Later registration for the same purl type wins. */
  register(module: AdapterModule): void {
    this.#byId.set(module.id, module);
    for (const purlType of module.purlTypes)
      this.#byPurlType.set(purlType.toLowerCase(), module);
  }

  registerAll(modules: readonly AdapterModule[]): void {
    for (const module of modules) this.register(module);
  }

  list(): readonly AdapterModule[] {
    return [...this.#byId.values()];
  }

  purlTypes(): readonly string[] {
    return [...this.#byPurlType.keys()].sort();
  }

  moduleFor(purlType: string): AdapterModule {
    const module = this.#byPurlType.get(purlType.toLowerCase());
    if (!module)
      throw new AdapterHostError(
        'UNSUPPORTED_ECOSYSTEM',
        `No adapter is registered for purl type "${purlType}". ` +
          `Registered: ${this.purlTypes().join(', ') || '(none)'}.`,
      );
    return module;
  }

  has(purlType: string): boolean {
    return this.#byPurlType.has(purlType.toLowerCase());
  }

  async definitionFor(
    purlType: string,
    context: AdapterContext = {},
  ): Promise<RegistryDefinition> {
    return this.moduleFor(purlType).registryDefinition(context);
  }

  codecFor(purlType: string): EcosystemCodec {
    const module = this.moduleFor(purlType);
    if (!module.codec)
      throw new AdapterHostError(
        'UNSUPPORTED_ECOSYSTEM',
        `Adapter ${module.id} does not export a codec`,
      );
    return module.codec();
  }

  /**
   * Catalog provider for a purl type, fail-closed when the registry definition
   * does not advertise package-metadata (inspect) or enumerate as required.
   */
  async catalogFor(
    purlType: string,
    context: AdapterContext = {},
    required: readonly string[] = ['prex.registry.package-metadata/1'],
  ): Promise<CatalogProvider> {
    const module = this.moduleFor(purlType);
    const definition = await module.registryDefinition(context);
    for (const type of required) requireResource(definition, type);
    if (!module.catalog)
      throw new AdapterHostError(
        'UNSUPPORTED_OPERATION',
        `Adapter ${module.id} does not export catalog`,
      );
    return module.catalog(context);
  }

  async installerFor(
    purlType: string,
    context: AdapterContext = {},
  ): Promise<InstallerProvider> {
    const module = this.moduleFor(purlType);
    const definition = await module.registryDefinition(context);
    requireResource(definition, 'prex.registry.install/1');
    if (!module.installer)
      throw new AdapterHostError(
        'UNSUPPORTED_OPERATION',
        `Adapter ${module.id} does not export install`,
      );
    return module.installer(context);
  }

  /**
   * Whether this purl type should use host/profile install (vs project store).
   * Driven by Registry Definition features / resources, not CLI grammar.
   */
  async prefersHostInstall(
    purlType: string,
    context: AdapterContext = {},
  ): Promise<boolean> {
    const definition = await this.definitionFor(purlType, context);
    if (!hasResource(definition, 'prex.registry.install/1')) return false;
    const side = definition.features?.installSideEffects;
    return (
      side === 'system' ||
      side === 'user-profile' ||
      // Install-only adapters without project-store materialize
      (!hasResource(definition, 'prex.registry.artifact/1') &&
        hasResource(definition, 'prex.registry.install/1'))
    );
  }

  /**
   * Project format for a purl type, or undefined when this ecosystem does not
   * offer one. Undefined rather than throwing: a project with no native
   * manifest to maintain is the ordinary case, not an error.
   */
  async projectFormatFor(
    purlType: string,
    context: AdapterContext = {},
  ): Promise<ProjectFormat | undefined> {
    if (!this.has(purlType)) return undefined;
    const module = this.moduleFor(purlType);
    if (!module.project) return undefined;
    const definition = await module.registryDefinition(context);
    if (!hasResource(definition, 'prex.registry.project-manifest/1'))
      return undefined;
    return module.project(context);
  }

  /** Which projection levels this ecosystem advertises. */
  async projectionLevels(
    purlType: string,
    context: AdapterContext = {},
  ): Promise<{ manifest: boolean; lock: boolean; layout: boolean }> {
    if (!this.has(purlType))
      return { manifest: false, lock: false, layout: false };
    const definition = await this.definitionFor(purlType, context);
    return {
      manifest: hasResource(definition, 'prex.registry.project-manifest/1'),
      lock: hasResource(definition, 'prex.registry.project-lock/1'),
      layout: hasResource(definition, 'prex.registry.project-layout/1'),
    };
  }

  async supportsSearch(
    purlType: string,
    context: AdapterContext = {},
  ): Promise<boolean> {
    return hasResource(
      await this.definitionFor(purlType, context),
      'prex.registry.search/1',
    );
  }
}

/** Process-wide default registry used by opm until config injects another. */
let defaultRegistry: AdapterRegistry | undefined;

export function getAdapterRegistry(): AdapterRegistry {
  if (!defaultRegistry)
    throw new AdapterHostError(
      'ADAPTER_REGISTRY_UNCONFIGURED',
      'No adapter registry is configured. Call setAdapterRegistry() with discovered modules.',
    );
  return defaultRegistry;
}

export function setAdapterRegistry(registry: AdapterRegistry): void {
  defaultRegistry = registry;
}

export function tryGetAdapterRegistry(): AdapterRegistry | undefined {
  return defaultRegistry;
}
