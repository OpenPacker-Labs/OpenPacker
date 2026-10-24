import type { JsonValue } from '@openpacker/contracts';
import { PackslipError, type PackslipErrorCode } from './errors.js';
import { shown } from './shown.js';

export type JsonObject = { [key: string]: JsonValue };

export function isJsonObject(
  value: JsonValue | undefined,
): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonArray(value: JsonValue | undefined): value is JsonValue[] {
  return Array.isArray(value);
}

/**
 * Reads typed fields from an untrusted JSON object and names the path of the
 * first one that is wrong. A signed document is still attacker-chosen input
 * until every field has been decoded into its domain type, so decoding is the
 * only place this package looks at raw JSON.
 */
export class ObjectReader {
  readonly #value: JsonObject;
  readonly #path: string;
  readonly #code: PackslipErrorCode;

  constructor(
    value: JsonValue | undefined,
    path: string,
    code: PackslipErrorCode = 'INVALID_STATEMENT',
  ) {
    this.#code = code;
    this.#path = path;
    if (!isJsonObject(value)) throw this.fail(path, 'must be an object');
    this.#value = value;
  }

  get path(): string {
    return this.#path;
  }

  fail(path: string, message: string): PackslipError {
    return new PackslipError(this.#code, `${path} ${message}`);
  }

  #at(key: string): string {
    return this.#path === '' ? key : `${this.#path}.${key}`;
  }

  has(key: string): boolean {
    return Object.hasOwn(this.#value, key) && this.#value[key] !== undefined;
  }

  raw(key: string): JsonValue | undefined {
    return Object.hasOwn(this.#value, key) ? this.#value[key] : undefined;
  }

  string(key: string): string {
    const value = this.raw(key);
    if (typeof value !== 'string' || value === '')
      throw this.fail(this.#at(key), 'must be a non-empty string');
    return value;
  }

  optionalString(key: string): string | undefined {
    return this.has(key) ? this.string(key) : undefined;
  }

  integer(key: string): number {
    const value = this.raw(key);
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
      throw this.fail(this.#at(key), 'must be a non-negative integer');
    return value;
  }

  optionalBoolean(key: string): boolean | undefined {
    const value = this.raw(key);
    if (value === undefined) return undefined;
    if (typeof value !== 'boolean')
      throw this.fail(this.#at(key), 'must be a boolean');
    return value;
  }

  object(key: string): ObjectReader {
    return new ObjectReader(this.raw(key), this.#at(key), this.#code);
  }

  optionalObject(key: string): ObjectReader | undefined {
    return this.has(key) ? this.object(key) : undefined;
  }

  /** The member values of an array field, each as its own raw JSON value. */
  array(key: string): JsonValue[] {
    const value = this.raw(key);
    if (!isJsonArray(value)) throw this.fail(this.#at(key), 'must be an array');
    return value;
  }

  optionalArray(key: string): JsonValue[] | undefined {
    return this.has(key) ? this.array(key) : undefined;
  }

  /** A reader for member `index` of the array field `key`. */
  element(
    key: string,
    index: number,
    values: readonly JsonValue[],
  ): ObjectReader {
    return new ObjectReader(
      values[index],
      `${this.#at(key)}[${index}]`,
      this.#code,
    );
  }

  stringArray(key: string): string[] {
    return this.array(key).map((value, index) => {
      if (typeof value !== 'string' || value === '')
        throw this.fail(
          `${this.#at(key)}[${index}]`,
          'must be a non-empty string',
        );
      return value;
    });
  }

  optionalStringArray(key: string): string[] | undefined {
    return this.has(key) ? this.stringArray(key) : undefined;
  }

  /** An object whose every member is a string, such as a resource's `env`. */
  optionalStringRecord(key: string): Record<string, string> | undefined {
    if (!this.has(key)) return undefined;
    const reader = this.object(key);
    const result: Record<string, string> = {};
    for (const member of Object.keys(reader.#value)) {
      const value = reader.#value[member];
      if (typeof value !== 'string')
        throw reader.fail(
          `${reader.#path}.${shown(member)}`,
          'must be a string',
        );
      result[member] = value;
    }
    return result;
  }

  /** `extensions` is opaque: keyed by who defines it, never interpreted. */
  optionalExtensions(): JsonObject | undefined {
    const value = this.raw('extensions');
    if (value === undefined) return undefined;
    if (!isJsonObject(value))
      throw this.fail(this.#at('extensions'), 'must be an object');
    return value;
  }
}
