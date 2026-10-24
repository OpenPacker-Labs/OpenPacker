import { describe, expect, it } from 'vitest';
import { parseCanonicalJson, printable } from '../src/index.js';

/**
 * The JSON parser builds objects with no prototype, and `String` throws a
 * `TypeError` on one ("Cannot convert object to primitive value"), and on an
 * array that holds one. A message that repeats a field of a document is written
 * while the document is being refused, and must not be the thing that throws.
 */
describe('printable', () => {
  it('says what a template literal says of a value that has a prototype', () => {
    expect(printable('text')).toBe('text');
    expect(printable(5)).toBe('5');
    expect(printable(true)).toBe('true');
    expect(printable(null)).toBe('null');
    expect(printable(undefined)).toBe('undefined');
    expect(printable(['x', 'y'])).toBe('x,y');
    expect(printable([])).toBe('');
  });

  it('does not throw on what the JSON parser builds', () => {
    const parsed = parseCanonicalJson('{"a":{"b":1},"c":[{"d":1}],"e":[1,2]}');
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
      throw new Error('not an object');
    expect(() => String(parsed.a)).toThrow(TypeError);
    expect(() => String(parsed.c)).toThrow(TypeError);
    expect(printable(parsed)).toBe('[object Object]');
    expect(printable(parsed.a)).toBe('[object Object]');
    expect(printable(parsed.c)).toBe('[object Array]');
    expect(printable(parsed.e)).toBe('1,2');
  });
});
