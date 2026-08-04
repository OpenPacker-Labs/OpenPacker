/**
 * Production bridge: WIT-shaped module surface implemented by TypeScript
 * guests until WASM components load.
 *
 * This is the only path core uses — whether the guest is a TS object or a
 * future wasmtime-loaded component exporting openpacker:prex-adapter@0.1.0.
 */

import { canonicalBytes } from '@openpacker/canonical';
import type { AdapterModule, RegistryDefinition } from './types.js';
import { AdapterHostError } from './types.js';
import { hasResource, resourceTypesOf } from './resources.js';

/** Bytes of a Registry Definition as returned by WIT registry.service-index. */
export async function serviceIndexBytes(
  module: AdapterModule,
): Promise<Uint8Array> {
  const definition = await module.registryDefinition();
  return canonicalBytes(definition as never);
}

/** Parse service-index bytes back to a definition (host side). */
export function parseServiceIndex(bytes: Uint8Array): RegistryDefinition {
  const text = new TextDecoder().decode(bytes);
  const value = JSON.parse(text) as RegistryDefinition;
  if (value.registryDefinitionVersion !== '1')
    throw new AdapterHostError(
      'INVALID_REGISTRY_DEFINITION',
      `Unsupported registryDefinitionVersion: ${String(value.registryDefinitionVersion)}`,
    );
  if (!Array.isArray(value.resources) || value.resources.length === 0)
    throw new AdapterHostError(
      'INVALID_REGISTRY_DEFINITION',
      'Registry Definition must advertise at least one resource',
    );
  return value;
}

/**
 * Resource types that require a catalog export on the module.
 * Advertising them without `catalog` is a capability lie.
 */
const CATALOG_RESOURCES = [
  'prex.registry.search/1',
  'prex.registry.enumerate-versions/1',
  'prex.registry.package-metadata/1',
  'prex.registry.artifact/1',
  'prex.registry.dependency-graph/1',
] as const;

const INSTALL_RESOURCES = [
  'prex.registry.install/1',
  'prex.registry.update/1',
  'prex.registry.uninstall/1',
] as const;

/**
 * Contract check used when a full wasmtime/jco host is unavailable: prove the
 * module satisfies the WIT-shaped surface the host will call.
 *
 * Component exports and Registry Definition resources MUST NOT disagree
 * (ADR 0032 / registry-definition.md).
 */
export async function assertWitShapedModule(
  module: AdapterModule,
): Promise<void> {
  if (!module.id || module.purlTypes.length === 0)
    throw new AdapterHostError(
      'INVALID_ADAPTER',
      'Adapter must declare id and purlTypes',
    );
  const definition = await module.registryDefinition();
  if (definition.registryDefinitionVersion !== '1')
    throw new AdapterHostError(
      'INVALID_REGISTRY_DEFINITION',
      'service-index must return registryDefinitionVersion 1',
    );
  const bytes = await serviceIndexBytes(module);
  const roundTrip = parseServiceIndex(bytes);
  if (roundTrip.registryId !== definition.registryId)
    throw new AdapterHostError(
      'INVALID_REGISTRY_DEFINITION',
      'service-index round-trip lost registryId',
    );
  // At least one of catalog, codec, installer must exist for a useful adapter.
  if (!module.codec && !module.catalog && !module.installer)
    throw new AdapterHostError(
      'INVALID_ADAPTER',
      `Adapter ${module.id} exports no codec, catalog, or installer`,
    );

  for (const type of CATALOG_RESOURCES) {
    if (hasResource(definition, type) && !module.catalog)
      throw new AdapterHostError(
        'INVALID_ADAPTER',
        `Adapter ${module.id} advertises ${type} but does not export catalog`,
      );
  }
  for (const type of INSTALL_RESOURCES) {
    if (hasResource(definition, type) && !module.installer)
      throw new AdapterHostError(
        'INVALID_ADAPTER',
        `Adapter ${module.id} advertises ${type} but does not export installer`,
      );
  }
  // uninstall/update require the install export; InstallerProvider v1 only has
  // plan+install, so advertising uninstall without a dedicated method is still
  // a lie — require the resource only when the module documents it via
  // installer AND we treat install resource as the gate. uninstall specifically:
  if (hasResource(definition, 'prex.registry.uninstall/1') && !module.installer)
    throw new AdapterHostError(
      'INVALID_ADAPTER',
      `Adapter ${module.id} advertises uninstall but does not export installer`,
    );
  // InstallerProvider has no uninstall method — advertising uninstall while
  // only exporting plan/install is dishonest. Reject unless the installer
  // object also exposes uninstall (optional extension).
  if (
    hasResource(definition, 'prex.registry.uninstall/1') &&
    module.installer
  ) {
    const installer = module.installer() as { uninstall?: unknown };
    if (typeof installer.uninstall !== 'function')
      throw new AdapterHostError(
        'INVALID_ADAPTER',
        `Adapter ${module.id} advertises prex.registry.uninstall/1 but installer has no uninstall()`,
      );
  }
  if (hasResource(definition, 'prex.registry.update/1') && module.installer) {
    const installer = module.installer() as { update?: unknown };
    if (typeof installer.update !== 'function')
      throw new AdapterHostError(
        'INVALID_ADAPTER',
        `Adapter ${module.id} advertises prex.registry.update/1 but installer has no update()`,
      );
  }
  if (
    hasResource(definition, 'prex.registry.environment/1') &&
    !module.environment
  )
    throw new AdapterHostError(
      'INVALID_ADAPTER',
      `Adapter ${module.id} advertises prex.registry.environment/1 but does not export environment`,
    );

  // Every advertised type must be known to the agreement rules above or
  // service-index / package-config / lifecycle (honesty-only).
  const known = new Set<string>([
    ...CATALOG_RESOURCES,
    ...INSTALL_RESOURCES,
    'prex.registry.service-index/1',
    'prex.registry.package-config/1',
    'prex.registry.lifecycle/1',
    'prex.registry.environment/1',
  ]);
  for (const resource of definition.resources) {
    for (const type of resourceTypesOf(resource['@type'])) {
      if (!known.has(type) && !type.startsWith('prex.registry.'))
        throw new AdapterHostError(
          'INVALID_REGISTRY_DEFINITION',
          `Adapter ${module.id} advertises unknown resource type ${type}`,
        );
    }
  }
}
