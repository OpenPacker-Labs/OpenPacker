import { ProviderError, parsePurl } from '@openpacker/adapter-core';
import type {
  ProviderInspection,
  ProviderRecord,
} from '@openpacker/adapter-core';
import type { RegistryDefinition } from '@openpacker/adapter-host';
import { canonicalBytes } from '@openpacker/canonical';
import {
  createPrexValidator,
  parseAndValidateContract,
  validateContract,
} from '@openpacker/conformance';
import type {
  DelegatedAdapterInspectionResult,
  DelegatedAdapterManifest,
  DelegatedAdapterOperation,
  DelegatedAdapterRecordResult,
  DelegatedAdapterRequest,
  DelegatedAdapterResponse,
  JsonValue,
  PackageIdentity,
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
const INSPECTION_RESULT_SCHEMA =
  'https://openpacker.dev/spec/prex/v1/schemas/delegated-adapter.schema.json#/$defs/DelegatedAdapterInspectionResult';
const RECORD_RESULT_SCHEMA =
  'https://openpacker.dev/spec/prex/v1/schemas/delegated-adapter.schema.json#/$defs/DelegatedAdapterRecordResult';
const SNAPSHOT_RESULT_SCHEMA =
  'https://openpacker.dev/spec/prex/v1/schemas/delegated-adapter.schema.json#/$defs/DelegatedAdapterSnapshotResult';

/**
 * RFC 3339 shape (a date-time with an explicit offset); Date.parse then
 * rejects impossible dates the shape alone would admit. Wire timestamps are
 * metadata the host reasons about, so "yesterday" or a bare date fail closed.
 */
const RFC3339_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

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

/**
 * Validate one ok-result against the normative schema for its operation, then
 * against the manifest and the request: a plugin may only answer with purl
 * types it declared, and an inspect answer must be for the exact package the
 * host asked about. Anything else fails closed as INVALID_RESPONSE.
 */
export function validateOperationResult(
  manifest: DelegatedAdapterManifest,
  operation: DelegatedAdapterOperation,
  result: JsonValue,
  params: DelegatedAdapterRequest['params'] = {},
): unknown {
  const invalid = (message: string): ProviderError =>
    new ProviderError(
      'INVALID_RESPONSE',
      `Plugin ${manifest.id} ${operation}: ${message}`,
    );
  const declared = new Set(manifest.purlTypes.map((t) => t.toLowerCase()));
  switch (operation) {
    case 'registry-definition': {
      const definition = validateSchema<RegistryDefinition>(
        REGISTRY_DEFINITION_SCHEMA,
        result,
        invalid,
      );
      // The definition must not claim ecosystems the manifest never declared.
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
      return result.map((item) => {
        const identity = validateSchema<PackageIdentity>(
          PACKAGE_IDENTITY_SCHEMA,
          item,
          invalid,
        );
        if (!declared.has(identity.purlType.toLowerCase()))
          throw invalid(
            `identify result ${identity.canonicalPurl} is outside the declared purl types`,
          );
        return identity;
      });
    }
    case 'enumerate': {
      if (!Array.isArray(result)) throw invalid('result is not an array');
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
      const wire = validateSchema<DelegatedAdapterInspectionResult>(
        INSPECTION_RESULT_SCHEMA,
        result,
        invalid,
      );
      // The answer must be for the package the host asked about, in an
      // ecosystem the manifest declared — anything else is a confused or
      // malicious plugin, not data.
      if (params.exactPurl === undefined)
        throw invalid(
          'inspect result cannot be checked: the request carried no exactPurl',
        );
      const answered = wire.package.identity.exactPurl;
      if (answered !== params.exactPurl)
        throw invalid(
          `inspect answered ${answered ?? '(no exactPurl)'} for the requested ${params.exactPurl}`,
        );
      let answeredType;
      try {
        answeredType = parsePurl(answered).type;
      } catch (error) {
        throw invalid(
          `inspect result is not a purl: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (!declared.has(answeredType))
        throw invalid(
          `inspect result ${answered} is outside the declared purl types`,
        );
      const inspection: ProviderInspection = {
        package: wire.package,
        record: wireRecordToRecord(wire.record, invalid),
        warnings: wire.warnings ?? [],
      };
      return inspection;
    }
    case 'fetch-artifact-record':
      return wireRecordToRecord(
        validateSchema<DelegatedAdapterRecordResult>(
          RECORD_RESULT_SCHEMA,
          result,
          invalid,
        ),
        invalid,
      );
    case 'snapshot':
      return validateSchema<SourceSnapshot>(
        SNAPSHOT_RESULT_SCHEMA,
        result,
        invalid,
      );
    default:
      // An operation outside the enum means the host and this validator
      // disagree about the protocol; refuse rather than guess a shape.
      throw new ProviderError(
        'UNSUPPORTED_OPERATION',
        `Plugin ${manifest.id}: unknown delegated operation ${String(operation)}`,
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
 * Turn a schema-validated wire record into a ProviderRecord. The normative
 * DelegatedAdapterRecordResult schema already bounded every field and
 * validateContract already enforced canonical JSON (body included); what
 * stays host-side is the timestamp check and reconstructing rawBody as the
 * canonical bytes of the answered body — bytes a plugin cannot desync.
 */
function wireRecordToRecord(
  record: DelegatedAdapterRecordResult,
  invalid: Invalid,
): ProviderRecord {
  if (
    !RFC3339_PATTERN.test(record.retrievedAt) ||
    !Number.isFinite(Date.parse(record.retrievedAt))
  )
    throw invalid('record.retrievedAt must be an RFC 3339 timestamp');
  return {
    key: record.key,
    endpoint: record.endpoint,
    ...(record.etag === undefined ? {} : { etag: record.etag }),
    ...(record.revision === undefined ? {} : { revision: record.revision }),
    body: record.body,
    rawBody: canonicalBytes(record.body),
    retrievedAt: record.retrievedAt,
  };
}
