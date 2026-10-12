import type {
  Digest,
  DigestProjection,
  JsonValue,
} from '@openpacker/contracts';
import { ParseBudget } from './budget.js';
import { safeEcho } from './echo.js';
import { CanonicalJsonError, type CanonicalParseLimits } from './errors.js';

export {
  CanonicalJsonError,
  CanonicalJsonLimitError,
  type CanonicalParseLimits,
} from './errors.js';
export { ECHO_LIMIT, plainLine, plainText, safeEcho } from './echo.js';
export {
  hasOverlongHost,
  LONGEST_HOST_LENGTH,
  writtenHostLength,
} from './url-host.js';

export interface CanonicalDigestProjection {
  readonly id: DigestProjection['id'];
  readonly algorithm: DigestProjection['algorithm'];
  readonly canonicalization: DigestProjection['canonicalization'];
  readonly includePaths: readonly string[];
  readonly excludePaths: readonly string[];
  readonly orderedSetPaths: readonly string[];
}

const DIGEST = /^sha256:([0-9a-f]{64})$/;
const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

export function compareCanonicalStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validString(value: string): string {
  if (LONE_SURROGATE.test(value))
    throw new CanonicalJsonError('Lone Unicode surrogate is not valid I-JSON');
  return value;
}

function encode(value: unknown, active: Set<object>): string {
  if (value === null || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(validString(value));
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || Object.is(value, -0))
      throw new CanonicalJsonError(
        'PREX canonical numbers must be finite safe integers and not negative zero',
      );
    return JSON.stringify(value);
  }
  if (typeof value !== 'object')
    throw new CanonicalJsonError(`Unsupported JSON value: ${typeof value}`);
  if (active.has(value))
    throw new CanonicalJsonError('Cyclic values are not JSON');
  active.add(value);
  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value))
          throw new CanonicalJsonError('Sparse arrays are not valid I-JSON');
        items.push(encode(value[index], active));
      }
      return `[${items.join(',')}]`;
    }
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null)
      throw new CanonicalJsonError('Only plain objects are canonicalizable');
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const entries = Object.keys(value as Record<string, unknown>)
      .map(validString)
      .sort()
      .map(
        (key) =>
          // SAFETY: The surrounding boundary establishes the asserted domain contract.
          `${JSON.stringify(key)}:${encode((value as Record<string, unknown>)[key], active)}`,
      );
    return `{${entries.join(',')}}`;
  } finally {
    active.delete(value);
  }
}

export function canonicalize(value: JsonValue): string {
  return encode(value, new Set());
}

export function canonicalBytes(value: JsonValue): Uint8Array {
  return new TextEncoder().encode(canonicalize(value));
}

class JsonParser {
  private index = 0;
  private readonly budget: ParseBudget;
  constructor(
    private readonly input: string,
    limits: CanonicalParseLimits,
  ) {
    this.budget = new ParseBudget(limits);
  }

  parse(): JsonValue {
    const value = this.value(0);
    this.space();
    if (this.index !== this.input.length) this.fail('Unexpected trailing data');
    canonicalize(value);
    return value;
  }

  private value(depth: number): JsonValue {
    this.budget.begin(depth, this.index);
    this.space();
    const character = this.input[this.index];
    if (character === '{') return this.object(depth);
    if (character === '[') return this.array(depth);
    if (character === '"') return this.string();
    if (character === 't') return this.literal('true', true);
    if (character === 'f') return this.literal('false', false);
    if (character === 'n') return this.literal('null', null);
    return this.number();
  }

  private object(depth: number): { [key: string]: JsonValue } {
    this.index += 1;
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const result: { [key: string]: JsonValue } = Object.create(null) as {
      [key: string]: JsonValue;
    };
    const keys = new Set<string>();
    this.space();
    if (this.take('}')) return result;
    while (true) {
      this.space();
      if (this.input[this.index] !== '"')
        this.fail('Object member name must be a string');
      const key = this.string();
      if (keys.has(key)) this.fail(`Duplicate object member: ${safeEcho(key)}`);
      keys.add(key);
      this.space();
      if (!this.take(':')) this.fail('Expected colon after object member name');
      result[key] = this.value(depth + 1);
      this.space();
      if (this.take('}')) return result;
      if (!this.take(',')) this.fail('Expected comma between object members');
    }
  }

  private array(depth: number): JsonValue[] {
    this.index += 1;
    const result: JsonValue[] = [];
    this.space();
    if (this.take(']')) return result;
    while (true) {
      result.push(this.value(depth + 1));
      this.space();
      if (this.take(']')) return result;
      if (!this.take(',')) this.fail('Expected comma between array values');
    }
  }

  private string(): string {
    const start = this.index;
    this.index += 1;
    let escaped = false;
    while (this.index < this.input.length) {
      const character = this.input[this.index];
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') {
        this.index += 1;
        try {
          return validString(
            // SAFETY: The surrounding boundary establishes the asserted domain contract.
            JSON.parse(this.input.slice(start, this.index)) as string,
          );
        } catch (error) {
          if (error instanceof CanonicalJsonError) throw error;
          this.fail('Invalid JSON string');
        }
      } else if (character !== undefined && character.charCodeAt(0) < 0x20)
        this.fail('Unescaped control character in string');
      this.index += 1;
    }
    return this.fail('Unterminated JSON string');
  }

  private number(): number {
    const match = this.input
      .slice(this.index)
      .match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (!match) return this.fail('Expected a JSON value');
    this.index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isSafeInteger(value) || Object.is(value, -0))
      this.fail(
        'PREX canonical numbers must be safe integers and not negative zero',
      );
    return value;
  }

  private literal<T extends JsonValue>(text: string, value: T): T {
    if (this.input.slice(this.index, this.index + text.length) !== text)
      return this.fail(`Expected ${text}`);
    this.index += text.length;
    return value;
  }

  private space(): void {
    while (/\s/u.test(this.input[this.index] ?? '')) this.index += 1;
  }

  private take(character: string): boolean {
    if (this.input[this.index] !== character) return false;
    this.index += 1;
    return true;
  }

  private fail(message: string): never {
    throw new CanonicalJsonError(
      `${message} at byte ${new TextEncoder().encode(this.input.slice(0, this.index)).length}`,
    );
  }
}

export function parseCanonicalJson<T = JsonValue>(
  text: string,
  limits: CanonicalParseLimits = {},
): T {
  // SAFETY: The canonical parser has validated the complete JSON document at this boundary.
  return new JsonParser(text, limits).parse() as T;
}

export async function sha256(bytes: Uint8Array): Promise<Digest> {
  const hash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes)),
  );
  return {
    algorithm: 'sha256',
    value: [...hash].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
  };
}

export async function canonicalDigest(value: JsonValue): Promise<Digest> {
  return sha256(canonicalBytes(value));
}

export function projectCanonicalValue(
  value: JsonValue,
  projection: CanonicalDigestProjection,
): JsonValue {
  let projected = projection.includePaths.length
    ? includeProjection(value, projection.includePaths)
    : cloneJson(value);
  for (const pointer of projection.excludePaths)
    visitParents(projected, pointerParts(pointer), (parent, key) => {
      if (Array.isArray(parent)) parent.splice(Number(key), 1);
      else delete parent[key];
    });
  for (const pointer of projection.orderedSetPaths)
    visitValues(projected, pointerParts(pointer), (candidate) => {
      if (Array.isArray(candidate))
        candidate.sort((left, right) => {
          const leftBytes = canonicalize(left);
          const rightBytes = canonicalize(right);
          return leftBytes < rightBytes ? -1 : leftBytes > rightBytes ? 1 : 0;
        });
    });
  return projected;
}

export async function canonicalProjectionDigest(
  value: JsonValue,
  projection: CanonicalDigestProjection,
): Promise<Digest> {
  return canonicalDigest(projectCanonicalValue(value, projection));
}

function cloneJson(value: JsonValue): JsonValue {
  return parseCanonicalJson(canonicalize(value));
}

function includeProjection(
  value: JsonValue,
  pointers: readonly string[],
): JsonValue {
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  const result: Record<string, JsonValue> = Object.create(null) as Record<
    string,
    JsonValue
  >;
  for (const pointer of pointers) {
    const parts = pointerParts(pointer);
    const selected = readPointer(value, parts);
    if (selected === undefined) continue;
    let target = result;
    for (const part of parts.slice(0, -1)) {
      const nested = target[part];
      if (
        typeof nested === 'object' &&
        nested !== null &&
        !Array.isArray(nested)
      )
        target = nested;
      else {
        // SAFETY: The surrounding boundary establishes the asserted domain contract.
        const created: Record<string, JsonValue> = Object.create(
          null,
        ) as Record<string, JsonValue>;
        target[part] = created;
        target = created;
      }
    }
    const key = parts.at(-1);
    if (key !== undefined) target[key] = cloneJson(selected);
  }
  return result;
}

function pointerParts(pointer: string): string[] {
  if (!pointer.startsWith('/'))
    throw new CanonicalJsonError(`Invalid JSON pointer: ${pointer}`);
  return pointer
    .slice(1)
    .split('/')
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'));
}

function readPointer(value: JsonValue, parts: string[]): JsonValue | undefined {
  let current: JsonValue = value;
  for (const part of parts) {
    if (typeof current !== 'object' || current === null || !(part in current))
      return undefined;
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    current = (current as Record<string, JsonValue>)[part]!;
  }
  return current;
}

function visitParents(
  value: JsonValue,
  parts: string[],
  visit: (parent: Record<string, JsonValue> | JsonValue[], key: string) => void,
): void {
  const key = parts.at(-1);
  if (key === undefined) return;
  visitValues(value, parts.slice(0, -1), (parent) => {
    if (typeof parent !== 'object' || parent === null) return;
    if (key === '*') {
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      for (const childKey of Object.keys(parent))
        visit(parent as Record<string, JsonValue> | JsonValue[], childKey);
    } else if (key in parent)
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      visit(parent as Record<string, JsonValue> | JsonValue[], key);
  });
}

function visitValues(
  value: JsonValue,
  parts: string[],
  visit: (value: JsonValue) => void,
): void {
  if (parts.length === 0) {
    visit(value);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  const [part, ...rest] = parts;
  if (part === '*') {
    for (const nested of Object.values(value)) visitValues(nested, rest, visit);
  } else if (part !== undefined && part in value)
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    visitValues((value as Record<string, JsonValue>)[part]!, rest, visit);
}

export function formatDigest(digest: Digest): string {
  const formatted = `${digest.algorithm}:${digest.value}`;
  if (!DIGEST.test(formatted))
    throw new TypeError('Invalid PREX SHA-256 digest');
  return formatted;
}

export function parseDigest(value: string): Digest {
  const match = DIGEST.exec(value);
  if (!match?.[1]) throw new TypeError('Invalid PREX SHA-256 digest');
  return { algorithm: 'sha256', value: match[1] };
}
