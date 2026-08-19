import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { ProviderError } from '@openpacker/adapter-core';
import type {
  DelegatedPackProviderManifest,
  JsonValue,
} from '@openpacker/contracts';
import {
  parseAndValidateContract,
  validateContract,
} from '@openpacker/conformance';

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
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        bytes.byteLength - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (
      BigInt(offset) !== opened.size ||
      opened.size !== after.size ||
      opened.mtimeNs !== after.mtimeNs ||
      opened.ctimeNs !== after.ctimeNs
    )
      invalid(`Provider manifest changed while reading: ${path}`);
    const result = parseAndValidateContract(
      MANIFEST_SCHEMA,
      bytes.toString('utf8'),
    );
    if (!result.valid || result.value === undefined)
      invalid(validationMessage(result.errors));
    return result.value as DelegatedPackProviderManifest;
  } finally {
    await handle.close();
  }
}

export function parseDelegatedPackProvider(
  value: unknown,
): DelegatedPackProviderManifest {
  const result = validateContract(MANIFEST_SCHEMA, value as JsonValue);
  if (!result.valid) invalid(validationMessage(result.errors));
  return value as DelegatedPackProviderManifest;
}

function validationMessage(
  errors: readonly { instancePath: string; message?: string }[],
): string {
  return `Provider does not match ${MANIFEST_SCHEMA}: ${errors
    .map(
      (error) =>
        `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`,
    )
    .join('; ')}`;
}

function invalid(message: string): never {
  throw new ProviderError('INVALID_PROVIDER_MANIFEST', message);
}
