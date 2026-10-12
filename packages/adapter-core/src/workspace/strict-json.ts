import type { JsonValue } from '@openpacker/contracts';
import { WorkspaceError } from './errors.js';

/**
 * The first key that appears twice in one object of `text`, or `undefined`.
 *
 * `text` must already be valid JSON. `JSON.parse` keeps the last of two equal
 * keys, so a manifest that lists `"name"` twice would be read as whichever came
 * second without anyone having chosen it, and two readers of one file could
 * disagree about which that is. Keys are compared after their escapes are
 * decoded, so `"a"` and `"a"` are the same key.
 */
export function findDuplicateJsonKey(text: string): string | undefined {
  // One entry per open container: the keys seen so far in an object, or
  // `undefined` for an array, whose strings are values.
  const open: (Set<string> | undefined)[] = [];
  let expectKey = false;
  let at = 0;
  while (at < text.length) {
    const character = text[at];
    if (character === '"') {
      let end = at + 1;
      while (end < text.length && text[end] !== '"')
        end += text[end] === '\\' ? 2 : 1;
      const keys = open.at(-1);
      if (keys !== undefined && expectKey) {
        const key = decodeKey(text.slice(at, end + 1));
        if (keys.has(key)) return key;
        keys.add(key);
        expectKey = false;
      }
      at = end + 1;
      continue;
    }
    if (character === '{') {
      open.push(new Set());
      expectKey = true;
    } else if (character === '[') {
      open.push(undefined);
      expectKey = false;
    } else if (character === '}' || character === ']') {
      open.pop();
      expectKey = false;
    } else if (character === ',') {
      expectKey = open.at(-1) !== undefined;
    } else if (character === ':') {
      expectKey = false;
    }
    at += 1;
  }
  return undefined;
}

function decodeKey(quoted: string): string {
  try {
    // SAFETY: the text is valid JSON, so a quoted key decodes to a string.
    return JSON.parse(quoted) as string;
  } catch {
    return quoted;
  }
}

/**
 * Parse a manifest the way a lock is parsed: a byte-order mark is dropped, and
 * a document that is not JSON, or that says one key twice in one object, is
 * refused rather than read generously.
 */
export function parseStrictJson(text: string, where: string): JsonValue {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let value: JsonValue;
  try {
    // SAFETY: JSON.parse returns the JSON value it parsed; callers narrow it.
    value = JSON.parse(body) as JsonValue;
  } catch (error) {
    throw new WorkspaceError(
      'WORKSPACE_MANIFEST_INVALID',
      `${where} is not valid JSON: ${error instanceof Error ? error.message : 'unreadable'}`,
      [where],
    );
  }
  const duplicate = findDuplicateJsonKey(body);
  if (duplicate !== undefined)
    throw new WorkspaceError(
      'WORKSPACE_MANIFEST_INVALID',
      `${where} lists the key ${JSON.stringify(duplicate)} twice in one object`,
      [where],
    );
  return value;
}
