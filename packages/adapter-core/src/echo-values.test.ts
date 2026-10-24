import { describe, expect, it } from 'vitest';
import { parseCanonicalJson } from '@openpacker/canonical';
import { echoed, echoedValue } from './echo.js';

/**
 * A message repeats a field of a document that is being refused, and the field
 * may be anything the JSON parser builds, an object with no prototype among it.
 * `String` throws on one; `echoed` says it as `[object Object]`.
 */
describe('echoed on a value the JSON parser built', () => {
  const parsed = parseCanonicalJson('{"o":{"a":1},"l":[{"a":1}],"n":null}');
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new Error('not an object');

  it.each([
    ['an object', parsed.o, '[object Object]'],
    ['an array that holds one', parsed.l, '[object Array]'],
    ['null', parsed.n, 'null'],
  ])('says %s', (_name, value, expected) => {
    // SAFETY: the value is what a document held in a field the type calls text.
    const asText = value as string;
    expect(echoed(asText)).toBe(expected);
    expect(echoedValue(asText)).toBe(expected);
  });
});
