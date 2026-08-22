import {
  ProviderError,
  type CatalogProvider,
  type ProviderCapabilities,
  type ProviderInspection,
  type ProviderRecord,
} from '@openpacker/adapter-core';
import type {
  AdapterContext,
  AdapterModule,
  RegistryDefinition,
} from '@openpacker/adapter-host';
import type {
  DelegatedAdapterManifest,
  PackageIdentity,
  SourceSnapshot,
} from '@openpacker/contracts';
import { admitsOperation } from './manifest.js';
import type { DelegatedPluginExecutor } from './executor.js';

/**
 * An installed delegated adapter plugin as a WIT-shaped AdapterModule.
 *
 * Version 1 delegates only the read-only registry-definition and catalog
 * surfaces: `codec`, `installer`, `project` and `packer` are deliberately
 * absent, so callers needing them fail closed through the existing
 * AdapterRegistry paths instead of reaching the plugin. `catalog` itself is
 * absent unless the manifest declares the catalog capability — a module
 * object, not a class, so absence is real and not a throwing stub.
 */
export function delegatedAdapterModule(
  manifest: DelegatedAdapterManifest,
  executor: DelegatedPluginExecutor,
  options: { now?: () => string } = {},
): AdapterModule {
  const withClock = (context: AdapterContext | undefined): AdapterContext => ({
    ...(!(options.now === undefined) && { now: options.now }),
    ...context,
  });

  // The definition is part of this registration's identity: invoke the
  // plugin once, validate, and cache; re-executing per lookup would make a
  // bounded read operation unbounded.
  let definition: RegistryDefinition | undefined;

  const module: AdapterModule = {
    id: manifest.id,
    purlTypes: [...manifest.purlTypes],
    async registryDefinition(context?: AdapterContext) {
      if (definition !== undefined) return definition;
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      const answered = (await executor.invoke({
        operation: 'registry-definition',
        params: {},
        context: withClock(context),
      })) as RegistryDefinition;
      definition = answered;
      return answered;
    },
  };
  if (manifest.capabilities.includes('catalog'))
    module.catalog = (context: AdapterContext) =>
      new DelegatedCatalogProvider(manifest, executor, withClock(context));
  return module;
}

class DelegatedCatalogProvider implements CatalogProvider {
  readonly providerId: string;
  readonly capabilities: ProviderCapabilities;

  constructor(
    private readonly manifest: DelegatedAdapterManifest,
    private readonly executor: DelegatedPluginExecutor,
    private readonly context: AdapterContext,
  ) {
    this.providerId = manifest.id;
    const operations = (
      ['identify', 'enumerate', 'inspect', 'snapshot'] as const
    ).filter((operation) => admitsOperation(manifest, operation));
    this.capabilities = {
      operations: [
        ...operations,
        // fetch-artifact-record is the artifact operation of CatalogProvider.
        ...(admitsOperation(manifest, 'fetch-artifact-record')
          ? (['artifact'] as const)
          : []),
      ],
      purlTypes: [...manifest.purlTypes],
      // The protocol carries no qualifier or target semantics; honesty first.
      qualifierSupport: 'none',
      targetSpecificSemantics: false,
      offlineReplay: false,
      extensions: {
        // The stdio protocol carries metadata only: when the manifest admits
        // fetch-artifact-record, artifact bytes are fetched host-side from
        // the record's locations and digest-verified (spec Artifact bytes).
        ...(admitsOperation(manifest, 'fetch-artifact-record') && {
          'openpacker/artifact-bytes': 'host-fetch',
        }),
      },
    };
  }

  async identify(
    query: string,
    signal?: AbortSignal,
  ): Promise<readonly PackageIdentity[]> {
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    return (await this.executor.invoke({
      operation: 'identify',
      params: { query },
      context: this.context,
      ...(!(signal === undefined) && { signal }),
    })) as PackageIdentity[];
  }

  async enumerate(
    basePurl: string,
    signal?: AbortSignal,
  ): Promise<readonly string[]> {
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    return (await this.executor.invoke({
      operation: 'enumerate',
      params: { basePurl },
      context: this.context,
      ...(!(signal === undefined) && { signal }),
    })) as string[];
  }

  async inspect(
    exactPurl: string,
    signal?: AbortSignal,
  ): Promise<ProviderInspection> {
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    return (await this.executor.invoke({
      operation: 'inspect',
      params: { exactPurl },
      context: this.context,
      ...(!(signal === undefined) && { signal }),
    })) as ProviderInspection;
  }

  async fetchArtifactRecord(
    exactPurl: string,
    signal?: AbortSignal,
  ): Promise<ProviderRecord> {
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    return (await this.executor.invoke({
      operation: 'fetch-artifact-record',
      params: { exactPurl },
      context: this.context,
      ...(!(signal === undefined) && { signal }),
    })) as ProviderRecord;
  }

  async snapshot(
    evaluationTime: string,
    signal?: AbortSignal,
  ): Promise<SourceSnapshot> {
    if (!admitsOperation(this.manifest, 'snapshot'))
      throw new ProviderError(
        'UNSUPPORTED_OPERATION',
        `Plugin ${this.manifest.id} does not declare the snapshot operation`,
      );
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    return (await this.executor.invoke({
      operation: 'snapshot',
      params: { evaluationTime },
      context: this.context,
      ...(!(signal === undefined) && { signal }),
    })) as SourceSnapshot;
  }
}
