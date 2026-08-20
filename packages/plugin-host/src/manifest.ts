import { join } from 'node:path';
import { parseAndValidateContract } from '@openpacker/conformance';
import type {
  DelegatedAdapterManifest,
  DelegatedAdapterOperation,
} from '@openpacker/contracts';
import { OpmError, readStableFile } from '@openpacker/opm-project';

export const DELEGATED_ADAPTER_MANIFEST_SCHEMA =
  'https://openpacker.dev/spec/prex/v1/schemas/delegated-adapter.schema.json#/$defs/DelegatedAdapterManifest';
export const DELEGATED_ADAPTER_RESPONSE_SCHEMA =
  'https://openpacker.dev/spec/prex/v1/schemas/delegated-adapter.schema.json#/$defs/DelegatedAdapterResponse';

const MAX_MANIFEST_BYTES = 1_048_576;

/** Operations a capability admits; everything else fails closed. */
export const CATALOG_OPERATIONS = [
  'identify',
  'enumerate',
  'inspect',
  'fetch-artifact-record',
] as const;

/**
 * Read and schema-validate the pinned manifest from a verified store entry.
 *
 * The read goes through the no-follow stable-file primitive, so a swapped or
 * linked manifest inside the entry fails closed here even though the tree
 * digest was already re-verified by the caller.
 */
export async function loadPluginManifest(
  storePath: string,
  manifestPath: string,
): Promise<DelegatedAdapterManifest> {
  const displayPath = join(storePath, manifestPath);
  const text = await readStableFile(displayPath, MAX_MANIFEST_BYTES);
  const result = parseAndValidateContract(
    DELEGATED_ADAPTER_MANIFEST_SCHEMA,
    text,
  );
  if (!result.valid || result.value === undefined)
    throw new OpmError(
      'INVALID_PLUGIN_MANIFEST',
      `Plugin manifest ${displayPath} does not match ${DELEGATED_ADAPTER_MANIFEST_SCHEMA}: ` +
        result.errors
          .map(
            (error) =>
              `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`,
          )
          .join('; '),
    );
  const manifest = result.value as unknown as DelegatedAdapterManifest;
  assertConsistentCapabilities(manifest, displayPath);
  return manifest;
}

/**
 * Capabilities and the commands map must agree exactly: a capability without
 * its operations is a lie the host would discover at call time, and a command
 * without its capability is an operation the host must never invoke.
 */
function assertConsistentCapabilities(
  manifest: DelegatedAdapterManifest,
  displayPath: string,
): void {
  const invalid = (message: string): never => {
    throw new OpmError(
      'INVALID_PLUGIN_MANIFEST',
      `Plugin manifest ${displayPath}: ${message}`,
    );
  };
  const operations = Object.keys(manifest.commands);
  for (const capability of manifest.capabilities) {
    const required: readonly DelegatedAdapterOperation[] =
      capability === 'registry-definition'
        ? ['registry-definition']
        : CATALOG_OPERATIONS;
    for (const operation of required)
      if (!(operation in manifest.commands))
        invalid(
          `declares capability "${capability}" without a ${operation} command`,
        );
  }
  for (const operation of operations) {
    if (operation === 'registry-definition') {
      if (!manifest.capabilities.includes('registry-definition'))
        invalid('provides registry-definition without its capability');
    } else if (!manifest.capabilities.includes('catalog')) {
      invalid(`provides ${operation} without the catalog capability`);
    }
  }
}

/** Whether the manifest admits this operation at all. */
export function admitsOperation(
  manifest: DelegatedAdapterManifest,
  operation: DelegatedAdapterOperation,
): boolean {
  const capability =
    operation === 'registry-definition' ? 'registry-definition' : 'catalog';
  return (
    manifest.capabilities.includes(capability) && operation in manifest.commands
  );
}
