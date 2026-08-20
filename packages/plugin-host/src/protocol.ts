import { ProviderError, parsePurl } from '@openpacker/adapter-core';
import type {
  ProviderInspection,
  ProviderRecord,
  ProviderWarning,
} from '@openpacker/adapter-core';
import type { RegistryDefinition } from '@openpacker/adapter-host';
import { canonicalBytes } from '@openpacker/canonical';
import {
  createPrexValidator,
  parseAndValidateContract,
  validateCanonicalValue,
  validateContract,
} from '@openpacker/conformance';
import type {
  DelegatedAdapterManifest,
  DelegatedAdapterOperation,
  DelegatedAdapterRequest,
  DelegatedAdapterResponse,
  JsonValue,
  PackageIdentity,
  PackageInstance,
  SourceSnapshot,
} from '@openpacker/contracts';
import { DELEGATED_ADAPTER_RESPONSE_SCHEMA } from './manifest.js';

/**
 * The bounded canonical-JSON stdio protocol of spec/prex/v1/delegated-adapter.md:
 * a versioned request document on stdin, a bounded response document on
 * stdout, and a per-operation result validated against the normative PREX
 * schema before the host uses it.
 */

const REGISTRY_DEFINITION_SCHEMA =
  'https://openpacker.dev/spec/prex/v1/schemas/registry-definition.schema.json#/$defs/RegistryDefinition';
const PACKAGE_IDENTITY_SCHEMA =
  'https://openpacker.dev/spec/prex/v1/schemas/model.schema.json#/$defs/PackageIdentity';
const PACKAGE_INSTANCE_SCHEMA =
  'https://openpacker.dev/spec/prex/v1/schemas/model.schema.json#/$defs/PackageInstance';
const SOURCE_SNAPSHOT_SCHEMA =
  'https://openpacker.dev/spec/prex/v1/schemas/model.schema.json#/$defs/SourceSnapshot';

/** Requests are schema-bounded to KiBs already; this is the hard stop. */
export const MAX_REQUEST_BYTES = 65_536;
/**
 * Delegated catalog answers are metadata, not artifact bytes. This is also
 * the sandbox policy's stdout ceiling, so the executor's budget and the
 * jail's budget agree.
 */
export const MAX_RESPONSE_BYTES = 1_048_576;

// Ajv compilation of the full PREX catalog is not free; share one validator.
const ajv = createPrexValidator();

export function buildRequestBytes(
  operation: DelegatedAdapterOperation,
  params: DelegatedAdapterRequest['params'],
): Uint8Array {
  const request: DelegatedAdapterRequest = {
    delegatedAdapterRequestVersion: '1',
    operation,
    params,
  };
  const bytes = canonicalBytes(request as unknown as JsonValue);
  if (bytes.byteLength > MAX_REQUEST_BYTES)
    throw new ProviderError(
      'INVALID_REQUEST',
      `Delegated adapter request exceeds ${MAX_REQUEST_BYTES} bytes`,
    );
  return bytes;
}

/**
 * Parse and schema-validate the bounded stdout document. Malformed JSON, a
 * wrong envelope, and oversize output are all the same fail-closed answer.
 */
export function parsePluginResponse(
  pluginId: string,
  stdout: string,
  maximumBytes: number,
): DelegatedAdapterResponse {
  const invalid = (message: string): never => {
    throw new ProviderError(
      'INVALID_RESPONSE',
      `Plugin ${pluginId}: ${message}`,
    );
  };
  if (Buffer.byteLength(stdout, 'utf8') > maximumBytes)
    invalid(`response exceeds ${maximumBytes} bytes`);
  const parsed = parseAndValidateContract(
    DELEGATED_ADAPTER_RESPONSE_SCHEMA,
    stdout,
    ajv,
  );
  if (!parsed.valid || parsed.value === undefined)
    invalid(
      `response does not match the DelegatedAdapterResponse schema: ${parsed.errors
        .map(
          (error) =>
            `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`,
        )
        .join('; ')}`,
    );
  const response = parsed.value as unknown as DelegatedAdapterResponse;
  if (response.ok && response.result === undefined)
    invalid('successful response carries no result');
  if (!response.ok && response.error === undefined)
    invalid('failed response carries no error');
  return response;
}

/** Validate one ok-result against the normative schema for its operation. */
export function validateOperationResult(
  manifest: DelegatedAdapterManifest,
  operation: DelegatedAdapterOperation,
  result: JsonValue,
): unknown {
  const invalid = (message: string): ProviderError =>
    new ProviderError(
      'INVALID_RESPONSE',
      `Plugin ${manifest.id} ${operation}: ${message}`,
    );
  switch (operation) {
    case 'registry-definition': {
      const definition = validateSchema<RegistryDefinition>(
        REGISTRY_DEFINITION_SCHEMA,
        result,
        invalid,
      );
      // The definition must not claim ecosystems the manifest never declared.
      const declared = new Set(manifest.purlTypes.map((t) => t.toLowerCase()));
      const extra = definition.purlTypes.filter(
        (type) => !declared.has(type.toLowerCase()),
      );
      if (extra.length > 0)
        throw invalid(
          `registry definition claims undeclared purl types: ${extra.join(', ')}`,
        );
      return definition;
    }
    case 'identify': {
      if (!Array.isArray(result)) throw invalid('result is not an array');
      return result.map((item) =>
        validateSchema<PackageIdentity>(PACKAGE_IDENTITY_SCHEMA, item, invalid),
      );
    }
    case 'enumerate': {
      if (!Array.isArray(result)) throw invalid('result is not an array');
      const declared = new Set(manifest.purlTypes.map((t) => t.toLowerCase()));
      return result.map((item): string => {
        if (typeof item !== 'string')
          throw invalid('enumerate result is not strings');
        let parsed;
        try {
          parsed = parsePurl(item);
        } catch (error) {
          throw invalid(
            `enumerate result is not a purl: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        if (parsed.version === undefined)
          throw invalid(`enumerate result is not an exact purl: ${item}`);
        if (!declared.has(parsed.type))
          throw invalid(
            `enumerate result ${item} is outside the declared purl types`,
          );
        return item;
      });
    }
    case 'inspect': {
      if (
        result === null ||
        typeof result !== 'object' ||
        Array.isArray(result)
      )
        throw invalid('result is not an object');
      const record = result as Record<string, JsonValue>;
      for (const key of Object.keys(record))
        if (!['package', 'record', 'warnings'].includes(key))
          throw invalid(`unexpected field ${key}`);
      const instance = record['package'];
      const wireRecord = record['record'];
      if (instance === undefined || wireRecord === undefined)
        throw invalid('result requires package and record');
      const inspection: ProviderInspection = {
        package: validateSchema<PackageInstance>(
          PACKAGE_INSTANCE_SCHEMA,
          instance,
          invalid,
        ),
        record: parseWireRecord(wireRecord, invalid),
        warnings: parseWireWarnings(record['warnings'], invalid),
      };
      return inspection;
    }
    case 'fetch-artifact-record':
      return parseWireRecord(result, invalid);
    case 'snapshot':
      return validateSchema<SourceSnapshot>(
        SOURCE_SNAPSHOT_SCHEMA,
        result,
        invalid,
      );
  }
}

type Invalid = (message: string) => ProviderError;

function validateSchema<T>(
  schemaReference: string,
  value: JsonValue,
  invalid: Invalid,
): T {
  const validated = validateContract(schemaReference, value, ajv);
  if (!validated.valid)
    throw invalid(
      `result does not match ${schemaReference}: ${validated.errors
        .map(
          (error) =>
            `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`,
        )
        .join('; ')}`,
    );
  return value as unknown as T;
}

/**
 * Wire shape of a ProviderRecord: the JSON body travels, and the host
 * reconstructs rawBody as its canonical bytes — bytes a plugin cannot desync
 * from the body it answered with.
 */
function parseWireRecord(value: JsonValue, invalid: Invalid): ProviderRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw invalid('record is not an object');
  const record = value as Record<string, JsonValue>;
  for (const key of Object.keys(record))
    if (
      !['key', 'endpoint', 'etag', 'revision', 'body', 'retrievedAt'].includes(
        key,
      )
    )
      throw invalid(`record has unexpected field ${key}`);
  const key = boundedString(record['key'], 'record.key', 4096, invalid);
  const endpoint = boundedString(
    record['endpoint'],
    'record.endpoint',
    4096,
    invalid,
  );
  const retrievedAt = boundedString(
    record['retrievedAt'],
    'record.retrievedAt',
    64,
    invalid,
  );
  const etag =
    record['etag'] === undefined
      ? undefined
      : boundedString(record['etag'], 'record.etag', 1024, invalid);
  const revision =
    record['revision'] === undefined
      ? undefined
      : boundedString(record['revision'], 'record.revision', 1024, invalid);
  const body = record['body'];
  if (body === undefined) throw invalid('record requires a body');
  const canonicalErrors = validateCanonicalValue(body);
  if (canonicalErrors.length > 0)
    throw invalid(
      `record body is not canonical JSON: ${canonicalErrors
        .map((error) => error.message ?? 'is invalid')
        .join('; ')}`,
    );
  return {
    key,
    endpoint,
    ...(etag === undefined ? {} : { etag }),
    ...(revision === undefined ? {} : { revision }),
    body,
    rawBody: canonicalBytes(body),
    retrievedAt,
  };
}

function parseWireWarnings(
  value: JsonValue | undefined,
  invalid: Invalid,
): ProviderWarning[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 64)
    throw invalid('warnings is not an array of at most 64 entries');
  return value.map((item): ProviderWarning => {
    if (item === null || typeof item !== 'object' || Array.isArray(item))
      throw invalid('warning is not an object');
    const warning = item as Record<string, JsonValue>;
    for (const key of Object.keys(warning))
      if (!['code', 'message', 'path'].includes(key))
        throw invalid(`warning has unexpected field ${key}`);
    const code = boundedString(warning['code'], 'warning.code', 128, invalid);
    const message = boundedString(
      warning['message'],
      'warning.message',
      8192,
      invalid,
    );
    const path =
      warning['path'] === undefined
        ? undefined
        : boundedString(warning['path'], 'warning.path', 4096, invalid);
    return { code, message, ...(path === undefined ? {} : { path }) };
  });
}

function boundedString(
  value: JsonValue | undefined,
  field: string,
  maximumLength: number,
  invalid: Invalid,
): string {
  if (typeof value !== 'string' || value.length === 0)
    throw invalid(`${field} must be a non-empty string`);
  if (value.length > maximumLength)
    throw invalid(`${field} exceeds ${maximumLength} characters`);
  return value;
}
