import { ProviderError, parsePurl } from '@openpacker/adapter-core';
import type {
  ProviderExecutable,
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
  DelegatedAdapterBin,
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

/**
 * Normative executables rules (spec/prex/v1/delegated-adapter.md): the name
 * safe-segment pattern mirrors the schema; `entry` is a Python
 * `module:callable`, the same shape opm-project's bins validation accepts.
 */
const BIN_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PYTHON_ENTRY_PATTERN = /^[A-Za-z0-9_.]+:[A-Za-z0-9_.]+$/;
const MAX_BIN_DECLARATIONS = 64;

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
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  const bytes = canonicalBytes(
    JSON.parse(JSON.stringify(request)) as JsonValue,
  );
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
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  const response = parsed.value as DelegatedAdapterResponse;
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
) {
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
        // The plugin's answer is preserved exactly: absent stays absent, and
        // an empty array stays an empty array ("declares no executables").
        ...(!(wire.executables === undefined) && {
          executables: validateBins(wire.executables, invalid),
        }),
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
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  return value as T;
}

/**
 * Enforce the normative Executables rules on a schema-validated array. The
 * schema already bounded shape, lengths and the name/path patterns; this pass
 * re-asserts those safety invariants at the trust boundary (defense in
 * depth) and enforces the rules the schema cannot express: `entry` required
 * if and only if the interpreter is python, unique names, and the count cap.
 */
function validateBins(
  bins: readonly DelegatedAdapterBin[],
  invalid: Invalid,
): readonly ProviderExecutable[] {
  if (bins.length > MAX_BIN_DECLARATIONS)
    throw invalid(`executables exceeds ${MAX_BIN_DECLARATIONS} declarations`);
  const names = new Set<string>();
  return bins.map((bin) => {
    if (!BIN_NAME_PATTERN.test(bin.name))
      throw invalid(`executables name is not a safe path segment: ${bin.name}`);
    if (bin.path.startsWith('/') || bin.path.includes('\\'))
      throw invalid(
        `executables path must be a relative POSIX path: ${bin.path}`,
      );
    // A drive prefix is an absolute root on Windows and a junk segment
    // elsewhere; generation validation rejects it too — refuse it here, at
    // the trust boundary, instead of failing later and elsewhere.
    if (/^[A-Za-z]:/u.test(bin.path))
      throw invalid(`executables path carries a drive prefix: ${bin.path}`);
    if (bin.path.split('/').includes('..'))
      throw invalid(`executables path contains a .. segment: ${bin.path}`);
    if (
      bin.interpreter !== undefined &&
      !['node', 'python', 'dotnet', 'native'].includes(bin.interpreter)
    )
      throw invalid(
        `executables has an unknown interpreter: ${bin.interpreter}`,
      );
    if (bin.interpreter === 'python') {
      if (bin.entry === undefined || !PYTHON_ENTRY_PATTERN.test(bin.entry))
        throw invalid(
          `executables ${bin.name} needs a module:callable entry for the python interpreter`,
        );
    } else if (bin.entry !== undefined) {
      throw invalid(
        `executables ${bin.name} declares an entry without the python interpreter`,
      );
    }
    if (names.has(bin.name))
      throw invalid(`executables has a duplicate name: ${bin.name}`);
    names.add(bin.name);
    return {
      name: bin.name,
      path: bin.path,
      ...(!(bin.interpreter === undefined) && { interpreter: bin.interpreter }),
      ...(!(bin.entry === undefined) && { entry: bin.entry }),
    };
  });
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
    ...(!(record.etag === undefined) && { etag: record.etag }),
    ...(!(record.revision === undefined) && { revision: record.revision }),
    body: record.body,
    rawBody: canonicalBytes(record.body),
    retrievedAt: record.retrievedAt,
  };
}
