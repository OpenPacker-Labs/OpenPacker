import {
  Ajv2020,
  type AnySchema,
  type ErrorObject,
  type ValidateFunction,
} from 'ajv/dist/2020.js';
import * as addFormatsModule from 'ajv-formats';
import { schemaCatalog, type JsonValue } from '@openpacker/contracts';
import { canonicalize, parseCanonicalJson } from '@openpacker/canonical';

export const PREX_CANONICAL_VALUE_LIMITS = {
  maximumDepth: 64,
  maximumValues: 1_000_000,
} as const;

export interface ValidationResult {
  readonly valid: boolean;
  readonly errors: readonly ErrorObject[];
}

export function createPrexValidator(): Ajv2020 {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    strictRequired: false,
    strictTypes: false,
    allowUnionTypes: true,
  });
  (addFormatsModule.default as unknown as (instance: Ajv2020) => Ajv2020)(ajv);
  for (const schema of Object.values(schemaCatalog))
    ajv.addSchema(schema as AnySchema);
  return ajv;
}

export function validateContract(
  schemaReference: string,
  value: JsonValue,
  ajv = createPrexValidator(),
): ValidationResult {
  const canonicalErrors = validateCanonicalValue(value);
  if (canonicalErrors.length > 0)
    return { valid: false, errors: canonicalErrors };
  const validate: ValidateFunction | undefined = ajv.getSchema(schemaReference);
  if (!validate)
    throw new Error(`Unknown PREX schema reference: ${schemaReference}`);
  return { valid: validate(value), errors: validate.errors ?? [] };
}

export function parseAndValidateContract(
  schemaReference: string,
  text: string,
  ajv = createPrexValidator(),
): ValidationResult & { readonly value?: JsonValue } {
  try {
    const value = parseCanonicalJson(text);
    return { ...validateContract(schemaReference, value, ajv), value };
  } catch (error) {
    return {
      valid: false,
      errors: [
        prexError(
          'canonicalJson',
          error instanceof Error ? error.message : 'Invalid PREX JSON text',
        ),
      ],
    };
  }
}

export function validateCanonicalValue(value: unknown): ErrorObject[] {
  const stack: Array<{ value: unknown; depth: number; exit?: boolean }> = [
    { value, depth: 0 },
  ];
  const active = new WeakSet<object>();
  let values = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.exit) {
      active.delete(current.value as object);
      continue;
    }
    values += 1;
    if (values > PREX_CANONICAL_VALUE_LIMITS.maximumValues)
      return [
        prexError('maximumValues', 'PREX document exceeds 1000000 values'),
      ];
    if (current.depth > PREX_CANONICAL_VALUE_LIMITS.maximumDepth)
      return [
        prexError('maximumDepth', 'PREX document exceeds nesting depth 64'),
      ];
    if (typeof current.value !== 'object' || current.value === null) continue;
    if (active.has(current.value))
      return [prexError('canonicalJson', 'Cyclic values are not JSON')];
    active.add(current.value);
    stack.push({ ...current, exit: true });
    for (const nested of Array.isArray(current.value)
      ? current.value
      : Object.values(current.value as Record<string, unknown>))
      stack.push({ value: nested, depth: current.depth + 1 });
  }
  try {
    canonicalize(value as JsonValue);
    return [];
  } catch (error) {
    return [
      prexError(
        'canonicalJson',
        error instanceof Error ? error.message : 'Invalid PREX canonical value',
      ),
    ];
  }
}

function prexError(keyword: string, message: string): ErrorObject {
  return {
    instancePath: '',
    schemaPath: `#/x-prex/${keyword}`,
    keyword,
    params: {},
    message,
  };
}

export interface ConformanceVector {
  readonly name: string;
  readonly schema: string;
  readonly valid: boolean;
  readonly levels: readonly string[];
  readonly value: JsonValue;
}

export interface ConformanceResult extends ConformanceVector {
  readonly actualValid: boolean;
  readonly errors: readonly ErrorObject[];
}

export function runConformanceVectors(
  vectors: readonly ConformanceVector[],
): ConformanceResult[] {
  const ajv = createPrexValidator();
  return vectors.map((vector) => {
    const result = validateContract(vector.schema, vector.value, ajv);
    return { ...vector, actualValid: result.valid, errors: result.errors };
  });
}
