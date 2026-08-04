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
 * Contract check used when a full wasmtime/jco host is unavailable: prove the
 * module satisfies the WIT-shaped surface the host will call.
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
}
