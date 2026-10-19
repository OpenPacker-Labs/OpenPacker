/**
 * The small readers `package-lock.json` is taken apart with.
 *
 * Everything in a lock is input, so each reader checks the shape it is given and
 * names the field when it is wrong: a lock that cannot be read faithfully is
 * refused, not read generously.
 */

import { echoed, ProviderError } from '@openpacker/adapter-core';

export type StringMap = Readonly<Record<string, string>>;

export function invalid(message: string): ProviderError {
  return new ProviderError('INVALID_LOCKFILE', message);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The first key that appears twice in one JSON object, or undefined.
 *
 * `JSON.parse` keeps the last of two equal keys, so a lock that lists one path
 * twice would install whichever came second without anyone having chosen it.
 */
export function findDuplicateJsonKey(text: string): string | undefined {
  const objects: (Set<string> | undefined)[] = [];
  let expectKey = false;
  let at = 0;
  while (at < text.length) {
    const character = text[at]!;
    if (character === '"') {
      let end = at + 1;
      while (end < text.length && text[end] !== '"')
        end += text[end] === '\\' ? 2 : 1;
      const open = objects.at(-1);
      if (open !== undefined && expectKey) {
        const raw = text.slice(at + 1, end);
        const key = raw.includes('\\') ? parseKey(raw) : raw;
        if (open.has(key)) return key;
        open.add(key);
        expectKey = false;
      }
      at = end + 1;
      continue;
    }
    if (character === '{') {
      objects.push(new Set());
      expectKey = true;
    } else if (character === '[') {
      objects.push(undefined);
      expectKey = false;
    } else if (character === '}' || character === ']') {
      objects.pop();
      expectKey = false;
    } else if (character === ',') {
      expectKey = objects.at(-1) !== undefined;
    } else if (character === ':') {
      expectKey = false;
    }
    at += 1;
  }
  return undefined;
}

function parseKey(raw: string): string {
  try {
    // SAFETY: JSON.parse of a quoted string yields a string.
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return raw;
  }
}

export function stringMap(value: unknown, where: string): StringMap {
  if (value === undefined) return {};
  if (!isRecord(value)) throw invalid(`${where} must be an object`);
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string')
      throw invalid(`${where}.${echoed(key)} must be a string`);
    out[key] = entry;
  }
  return out;
}

export function stringList(
  value: unknown,
  where: string,
): string[] | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return [value];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))
    throw invalid(`${where} must be a list of strings`);
  return value as string[];
}

export function flag(
  record: Record<string, unknown>,
  key: string,
  where: string,
): boolean {
  const value = record[key];
  if (value === undefined) return false;
  if (typeof value !== 'boolean')
    throw invalid(`${where}.${key} must be true or false`);
  return value;
}

export function optionalString(
  record: Record<string, unknown>,
  key: string,
  where: string,
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string')
    throw invalid(`${where}.${key} must be a string`);
  return value;
}

export function metaMap(value: unknown, where: string) {
  if (value === undefined) return {};
  if (!isRecord(value)) throw invalid(`${where} must be an object`);
  const out: Record<string, { optional?: boolean }> = {};
  for (const [key, entry] of Object.entries(value))
    out[key] =
      isRecord(entry) && entry.optional === true ? { optional: true } : {};
  return out;
}
