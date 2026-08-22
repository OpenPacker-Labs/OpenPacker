/**
 * Production v1 bridge: WIT-shaped TypeScript module surface.
 *
 * OpenPacker v1 loads AdapterModule objects (and sandboxed native plugins via
 * plugin-host). It does not load WebAssembly components. The WIT world
 * openpacker:prex-adapter@0.1.0 remains the ABI shape this check enforces.
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
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  return canonicalBytes(definition as never);
}

/** Parse service-index bytes back to a definition (host side). */
export function parseServiceIndex(bytes: Uint8Array): RegistryDefinition {
  const text = new TextDecoder().decode(bytes);
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
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

/** Resource types that require a `project` export on the module. */
const PROJECT_RESOURCES = [
  'prex.registry.project-manifest/1',
  'prex.registry.project-lock/1',
  'prex.registry.project-layout/1',
] as const;

/**
 * Shape every reserved resource type must have, per
 * `spec/prex/v1/registry-resource-types.md`: `prex.registry.<name>/<major>`.
 */
const RESERVED_TYPE = /^prex\.registry\.[a-z][a-z0-9-]*\/[1-9][0-9]*$/u;

/**
 * Contract check for the v1 TypeScript host: prove the module satisfies the
 * WIT-shaped surface. A wasmtime/jco component loader is not part of v1.
 *
 * Component exports and Registry Definition resources MUST NOT disagree
 * (ADR 0032 / registry-definition.md).
 */
export async function assertWitContractModule(
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
  // At least one capability export must exist for a useful adapter.
  if (!module.codec && !module.catalog && !module.installer && !module.packer)
    throw new AdapterHostError(
      'INVALID_ADAPTER',
      `Adapter ${module.id} exports no codec, catalog, installer, or packer`,
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
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const installer = module.installer() as { uninstall?: unknown };
    if (typeof installer.uninstall !== 'function')
      throw new AdapterHostError(
        'INVALID_ADAPTER',
        `Adapter ${module.id} advertises prex.registry.uninstall/1 but installer has no uninstall()`,
      );
  }
  if (hasResource(definition, 'prex.registry.update/1') && module.installer) {
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
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
  if (
    hasResource(definition, 'prex.registry.package-build/2') &&
    !module.packer
  )
    throw new AdapterHostError(
      'INVALID_ADAPTER',
      `Adapter ${module.id} advertises prex.registry.package-build/2 but does not export packer`,
    );

  // Project-format levels are nested: writing a lockfile or a layout without
  // being able to write the manifest they belong to is not a thing a project
  // format can honestly claim.
  for (const type of PROJECT_RESOURCES) {
    if (hasResource(definition, type) && !module.project)
      throw new AdapterHostError(
        'INVALID_ADAPTER',
        `Adapter ${module.id} advertises ${type} but does not export project`,
      );
  }
  if (module.project) {
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const format = module.project() as {
      writeLockfile?: unknown;
      writeLayout?: unknown;
    };
    if (
      hasResource(definition, 'prex.registry.project-lock/1') &&
      typeof format.writeLockfile !== 'function'
    )
      throw new AdapterHostError(
        'INVALID_ADAPTER',
        `Adapter ${module.id} advertises prex.registry.project-lock/1 but its project format has no writeLockfile()`,
      );
    if (
      hasResource(definition, 'prex.registry.project-layout/1') &&
      typeof format.writeLayout !== 'function'
    )
      throw new AdapterHostError(
        'INVALID_ADAPTER',
        `Adapter ${module.id} advertises prex.registry.project-layout/1 but its project format has no writeLayout()`,
      );
  }

  // A resource type this host does not know is not a lie — it is a newer
  // vocabulary entry, and registry-resource-types.md requires v1 clients to
  // ignore what they do not recognise. Rejecting them would mean every new
  // `prex.registry.<name>/<major>` breaks adapters on hosts that predate it,
  // which is the opposite of what a versioned vocabulary is for.
  //
  // What is still refused is a malformed reserved type: `prex.` claims the
  // PREX namespace, so anything in it has to be shaped like the vocabulary it
  // claims to belong to. Unrecognised types are dropped, never honoured, so an
  // adapter cannot gain a capability by inventing a name.
  for (const resource of definition.resources) {
    for (const type of resourceTypesOf(resource['@type'])) {
      if (type.startsWith('prex.') && !RESERVED_TYPE.test(type))
        throw new AdapterHostError(
          'INVALID_REGISTRY_DEFINITION',
          `Adapter ${module.id} advertises malformed reserved resource type ${type}. ` +
            'Types under "prex." must be "prex.registry.<name>/<major>"; use a ' +
            'vendor namespace for extensions.',
        );
    }
  }
}
