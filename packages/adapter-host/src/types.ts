import type {
  CatalogProvider,
  EcosystemCodec,
  InstallerProvider,
} from '@openpacker/adapter-core';

/**
 * WIT-shaped adapter module (openpacker:prex-adapter@0.1.0).
 *
 * Production loads these through discovery; TypeScript objects implement the
 * same boundary until WASM components ship. Core never imports a concrete
 * package-manager package by name.
 */

/** Versioned resource type from the Registry Definition vocabulary. */
export type RegistryResourceType =
  | 'prex.registry.service-index/1'
  | 'prex.registry.search/1'
  | 'prex.registry.enumerate-versions/1'
  | 'prex.registry.package-metadata/1'
  | 'prex.registry.package-config/1'
  | 'prex.registry.artifact/1'
  | 'prex.registry.dependency-graph/1'
  | 'prex.registry.install/1'
  | 'prex.registry.update/1'
  | 'prex.registry.uninstall/1'
  | 'prex.registry.environment/1'
  | 'prex.registry.lifecycle/1'
  | (string & {});

export interface RegistryResource {
  '@id': string;
  '@type': RegistryResourceType | readonly RegistryResourceType[];
  comment?: string;
  mediaTypes?: readonly string[];
  clientVersion?: string;
  extensions?: Readonly<Record<string, unknown>>;
}

export interface RegistryDefinition {
  registryDefinitionVersion: '1';
  registryId: string;
  displayName?: string;
  purlTypes: readonly string[];
  protocol?: {
    native?: string;
    transport?: readonly string[];
  };
  resources: readonly RegistryResource[];
  features?: {
    offlineReplay?: boolean;
    signedMetadata?: boolean;
    installSideEffects?:
      | 'none'
      | 'project-store'
      | 'user-profile'
      | 'system'
      | 'unknown';
    reversibility?:
      | 'none'
      | 'uninstall'
      | 'project-generation'
      | 'native-generation'
      | 'unknown';
    requiresElevation?: 'never' | 'sometimes' | 'always' | 'unknown';
  };
  limits?: {
    maxEnumerate?: number;
    maxSearchResults?: number;
    maxArtifactBytes?: number;
  };
  semanticLossDefaults?: readonly unknown[];
  extensions?: Readonly<Record<string, unknown>>;
}

/**
 * Factory context passed when materialising catalog/install providers.
 * Hosts inject transport and clocks; adapters do not assume globals.
 */
export interface AdapterContext {
  offline?: boolean;
  endpoint?: string;
  transport?: unknown;
  fetch?: typeof fetch;
  now?: () => string;
}

export interface AdapterModule {
  /** Stable adapter id, e.g. org.openpacker.adapter.npm */
  readonly id: string;
  /** PURL types this module owns. */
  readonly purlTypes: readonly string[];
  /** Capability-discoverable registry definition for the default source. */
  registryDefinition(
    context?: AdapterContext,
  ): RegistryDefinition | Promise<RegistryDefinition>;
  codec?(): EcosystemCodec;
  catalog?(context: AdapterContext): CatalogProvider;
  installer?(context?: AdapterContext): InstallerProvider;
  /**
   * Optional environment projection (mise/nix). Returns canonical JSON bytes
   * or a plain object for PATH/env.
   */
  environment?(
    exactPurl: string,
    context?: AdapterContext,
  ): Promise<Record<string, unknown>> | Record<string, unknown>;
}

export class AdapterHostError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'AdapterHostError';
    this.code = code;
  }
}
