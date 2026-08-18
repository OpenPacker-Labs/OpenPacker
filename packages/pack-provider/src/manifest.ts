import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { ProviderError } from '@openpacker/adapter-core';
import type {
  DelegatedPackProviderManifest,
  JsonValue,
} from '@openpacker/contracts';
import { validateContract } from '@openpacker/conformance';

const MAX_MANIFEST_BYTES = 1_048_576;
const MANIFEST_SCHEMA =
  'https://openpacker.dev/spec/prex/v1/schemas/delegated-pack-provider.schema.json#/$defs/DelegatedPackProviderManifest';

export async function loadDelegatedPackProvider(
  path: string,
): Promise<DelegatedPackProviderManifest> {
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink())
    invalid(`Provider manifest must be a regular file: ${path}`);
  if (before.size > BigInt(MAX_MANIFEST_BYTES))
    invalid(`Provider manifest exceeds ${MAX_MANIFEST_BYTES} bytes: ${path}`);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat({ bigint: true });
    if (opened.dev !== before.dev || opened.ino !== before.ino)
      invalid(`Provider manifest changed while opening: ${path}`);
    const text = await handle.readFile('utf8');
    const after = await handle.stat({ bigint: true });
    if (
      opened.size !== after.size ||
      opened.mtimeNs !== after.mtimeNs ||
      opened.ctimeNs !== after.ctimeNs
    )
      invalid(`Provider manifest changed while reading: ${path}`);
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (error) {
      invalid(
        `Provider manifest is not JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return parseDelegatedPackProvider(value);
  } finally {
    await handle.close();
  }
}

export function parseDelegatedPackProvider(
  value: unknown,
): DelegatedPackProviderManifest {
  const result = validateContract(MANIFEST_SCHEMA, value as JsonValue);
  if (!result.valid)
    invalid(
      `Provider does not match ${MANIFEST_SCHEMA}: ${result.errors
        .map(
          (error) =>
            `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`,
        )
        .join('; ')}`,
    );
  return value as DelegatedPackProviderManifest;
}

function invalid(message: string): never {
  throw new ProviderError('INVALID_PROVIDER_MANIFEST', message);
}
