import type {
  CatalogProvider,
  EcosystemCodec,
  InstallerProvider,
  PackagePacker,
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
  readonly #bySource = new Map<string, AdapterModule>();
  readonly #packProviders = new Map<string, Map<string, PackagePacker>>();
  readonly #defaultPackProvider = new Map<string, PackagePacker>();

  /**
   * Register a module as the default for the purl types it declares.
   *
   * Later registration for the same purl type wins, which is how a
   * distribution pack is overridden. A module registered this way answers when
   * no source was named.
   */
  register(module: AdapterModule): void {
    this.#byId.set(module.id, module);
    for (const purlType of module.purlTypes)
      this.#byPurlType.set(purlType.toLowerCase(), module);
  }

  registerAll(modules: readonly AdapterModule[]): void {
    for (const module of modules) this.register(module);
  }

  registerPackProvider(
    packer: PackagePacker,
    options: { makeDefault?: boolean } = {},
  ): void {
    const providerId = packer.providerId.toLowerCase();
    const purlType = packer.purlType.toLowerCase();
    const byType = this.#packProviders.get(providerId) ?? new Map();
    if (byType.has(purlType))
      throw new AdapterHostError(
        'INVALID_ADAPTER',
        `Pack provider ${packer.providerId} already owns purl type ${packer.purlType}`,
      );
    const existingDefault = this.#defaultPackProvider.get(purlType);
    if (options.makeDefault === true && existingDefault)
      throw new AdapterHostError(
        'INVALID_ADAPTER',
        `Purl type ${packer.purlType} already defaults to pack provider ${existingDefault.providerId}`,
      );
    byType.set(purlType, packer);
    this.#packProviders.set(providerId, byType);
    if (options.makeDefault === true)
      this.#defaultPackProvider.set(purlType, packer);
  }

  packProviderIds(): readonly string[] {
    return [...this.#packProviders.keys()].sort();
  }

  delegatedPackerFor(purlType: string, providerId?: string): PackagePacker {
    const type = purlType.toLowerCase();
    const packer =
      providerId === undefined
        ? this.#defaultPackProvider.get(type)
        : this.#packProviders.get(providerId.toLowerCase())?.get(type);
    if (!packer)
      throw new AdapterHostError(
        'UNSUPPORTED_ECOSYSTEM',
        providerId === undefined
          ? `No delegated pack provider is the default for purl type "${purlType}".`
          : `Pack provider "${providerId}" does not support purl type "${purlType}".`,
      );
    return packer;
  }

  /**
   * Register a module under a name, without claiming a purl type's default.
   *
   * A package source is not the same thing as an ecosystem. One PREX registry
   * may serve npm, PyPI and NuGet packages at once, and registering it the
   * ordinary way would silently displace the adapter that talks to npmjs.org —
   * or be displaced by it, depending on which pack loaded last. A named source
   * is reachable only when a caller asks for it.
   */
  registerSource(sourceId: string, module: AdapterModule): void {
    const key = sourceId.trim().toLowerCase();
    if (key === '')
      throw new AdapterHostError(
        'INVALID_ADAPTER',
        'A named source needs a non-empty id',
      );
    this.#byId.set(module.id, module);
    this.#bySource.set(key, module);
  }

  list(): readonly AdapterModule[] {
    return [...this.#byId.values()];
  }

  purlTypes(): readonly string[] {
    return [...this.#byPurlType.keys()].sort();
  }

  sourceIds(): readonly string[] {
    return [...this.#bySource.keys()].sort();
  }

  /**
   * The module that answers for a purl type, honouring a named source.
   *
   * Whether the named source can actually serve this purl type is settled
   * against its Registry Definition in `definitionFor`, not here — the
   * definition is the authority on that, and it may need I/O to read.
   */
  moduleFor(purlType: string, sourceId?: string): AdapterModule {
    if (sourceId !== undefined) return this.moduleForSource(sourceId);
    const module = this.#byPurlType.get(purlType.toLowerCase());
    if (!module)
      throw new AdapterHostError(
        'UNSUPPORTED_ECOSYSTEM',
        `No adapter is registered for purl type "${purlType}". ` +
          `Registered: ${this.purlTypes().join(', ') || '(none)'}.`,
      );
    return module;
  }

  moduleForSource(sourceId: string): AdapterModule {
    const module = this.#bySource.get(sourceId.trim().toLowerCase());
    if (!module)
      throw new AdapterHostError(
        'UNKNOWN_SOURCE',
        `No source named "${sourceId}" is registered. ` +
          `Registered: ${this.sourceIds().join(', ') || '(none)'}.`,
      );
    return module;
  }

  hasSource(sourceId: string): boolean {
    return this.#bySource.has(sourceId.trim().toLowerCase());
  }

  has(purlType: string): boolean {
    return this.#byPurlType.has(purlType.toLowerCase());
  }

  async definitionFor(
    purlType: string,
    context: AdapterContext = {},
  ): Promise<RegistryDefinition> {
    const module = this.moduleFor(purlType, context.sourceId);
    const definition = await module.registryDefinition(context);
    // A named source is used for this purl type only if it says it serves it.
    // Falling back to the ecosystem default here would quietly fetch from
    // somewhere the caller did not ask for, which is the opposite of what
    // naming a source is for.
    if (
      context.sourceId !== undefined &&
      !definition.purlTypes.some(
        (type) => type.toLowerCase() === purlType.toLowerCase(),
      )
    )
      throw new AdapterHostError(
        'UNSUPPORTED_ECOSYSTEM',
        `Source "${context.sourceId}" does not serve purl type "${purlType}". ` +
          `It serves: ${definition.purlTypes.join(', ') || '(none)'}.`,
      );
    return definition;
  }

  /**
   * Codec for a purl type. Deliberately not source-aware: a codec is the
   * ecosystem's own version and range semantics, and those do not change
   * because the bytes came from a mirror.
   */
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
   *
   * Honours `context.sourceId`, so this is where "get chalk from our mirror
   * rather than from npmjs.org" is decided.
   */
  async catalogFor(
    purlType: string,
    context: AdapterContext = {},
    required: readonly string[] = ['prex.registry.package-metadata/1'],
  ): Promise<CatalogProvider> {
    const module = this.moduleFor(purlType, context.sourceId);
    const definition = await this.definitionFor(purlType, context);
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

  async packerFor(
    purlType: string,
    context: AdapterContext = {},
  ): Promise<PackagePacker> {
    const module = this.moduleFor(purlType);
    const definition = await module.registryDefinition(context);
    requireResource(definition, 'prex.registry.package-build/2');
    if (!module.packer)
      throw new AdapterHostError(
        'UNSUPPORTED_OPERATION',
        `Adapter ${module.id} does not export packer`,
      );
    return module.packer(context);
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
