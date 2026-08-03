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
  const structuralErrors = validateStructuralInvariants(value);
  if (structuralErrors.length > 0)
    return { valid: false, errors: structuralErrors };
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

/**
 * Structural invariants that JSON Schema 2020-12 cannot express, checked the
 * same way duplicate object members are: outside the schema, before it is
 * trusted. Each rule is stated normatively in spec/prex/v1/semantics.md.
 *
 * Rules are matched by shape rather than by schema pointer so that a construct
 * validates identically wherever it is embedded.
 */
export function validateStructuralInvariants(value: unknown): ErrorObject[] {
  const errors: ErrorObject[] = [];
  const visit = (node: unknown, path: string): void => {
    if (typeof node !== 'object' || node === null) return;
    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, `${path}/${index}`));
      return;
    }
    const record = node as Record<string, unknown>;

    // A package's output names identify its parts; duplicates make an output
    // selector ambiguous.
    if (Array.isArray(record.outputs)) {
      const names = record.outputs
        .filter(
          (item): item is { name: string } =>
            typeof item === 'object' &&
            item !== null &&
            typeof (item as { name?: unknown }).name === 'string',
        )
        .map((item) => item.name);
      if (new Set(names).size !== names.length)
        errors.push(
          prexError(
            'uniqueOutputNames',
            `Duplicate output name at ${path}/outputs`,
          ),
        );
      const defaults = record.outputs.filter(
        (item) =>
          typeof item === 'object' &&
          item !== null &&
          (item as { default?: unknown }).default === true,
      );
      if (defaults.length > 1)
        errors.push(
          prexError(
            'singleDefaultOutput',
            `More than one default output at ${path}/outputs`,
          ),
        );
    }

    // A tree manifest with two entries for one path does not identify a tree.
    // Path shape is also checked here: the schema pattern needs lookaheads,
    // which several non-JavaScript validators do not support.
    if (record.manifestVersion === '1' && Array.isArray(record.entries)) {
      for (const [index, item] of record.entries.entries()) {
        const entryPath =
          typeof item === 'object' && item !== null
            ? (item as { path?: unknown }).path
            : undefined;
        if (typeof entryPath !== 'string') continue;
        const segments = entryPath.split('/');
        const unsafe =
          entryPath.startsWith('/') ||
          entryPath.includes('\\') ||
          // eslint-disable-next-line no-control-regex
          /[\u0000-\u001f\u007f]/u.test(entryPath) ||
          segments.some(
            (segment) =>
              segment.length === 0 || segment === '.' || segment === '..',
          );
        if (unsafe)
          errors.push(
            prexError(
              'treePathShape',
              `Unsafe tree manifest path at ${path}/entries/${index}`,
            ),
          );
      }
      const paths = record.entries
        .filter(
          (item): item is { path: string } =>
            typeof item === 'object' &&
            item !== null &&
            typeof (item as { path?: unknown }).path === 'string',
        )
        .map((item) => item.path);
      if (new Set(paths).size !== paths.length)
        errors.push(
          prexError(
            'uniqueTreePaths',
            `Duplicate tree manifest path at ${path}/entries`,
          ),
        );
    }

    // The current generation must be retained, or the pointer names a record
    // that may already have been collected.
    if (
      typeof record.currentGenerationDigest === 'object' &&
      record.currentGenerationDigest !== null &&
      Array.isArray(record.retainedGenerationDigests)
    ) {
      const current = (record.currentGenerationDigest as { value?: unknown })
        .value;
      const retained = record.retainedGenerationDigests.map((item) =>
        typeof item === 'object' && item !== null
          ? (item as { value?: unknown }).value
          : undefined,
      );
      if (!retained.includes(current))
        errors.push(
          prexError(
            'currentGenerationRetained',
            `currentGenerationDigest is not retained at ${path}`,
          ),
        );
    }

    for (const [key, nested] of Object.entries(record))
      visit(nested, `${path}/${key}`);
  };
  visit(value, '');
  return errors;
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
