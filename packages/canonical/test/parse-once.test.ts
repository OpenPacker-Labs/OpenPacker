import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CanonicalJsonError,
  canonicalize,
  parseCanonicalJson,
} from '../src/index.js';

/**
 * The parser checks each part of the tree as it builds it: a string or a name
 * with a lone surrogate, a number that is not a safe integer or is -0, a
 * duplicate name, and every object is made without a prototype. Encoding the
 * finished tree again checked nothing more, and it held a second copy of the
 * document's text at the parse's peak, so the parse no longer does it.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a parse', () => {
  it('does not encode the tree it built', () => {
    const stringify = vi.spyOn(JSON, 'stringify');
    parseCanonicalJson('{"a":[1,"x",{"b":null,"c":true}],"€":-5}');
    expect(stringify).not.toHaveBeenCalled();
  });

  it.each([
    ['a lone surrogate in a value', '["\\ud800"]'],
    ['a lone surrogate in a name', '{"\\udc00":1}'],
    ['negative zero', '[-0]'],
    ['a number past the safe integers', '[9007199254740992]'],
    ['a fraction', '[1.5]'],
    ['a duplicate name', '{"a":1,"a":2}'],
  ])('still refuses what encoding it would have: %s', (_, text) => {
    expect(() => parseCanonicalJson(text)).toThrow(CanonicalJsonError);
  });

  it('gives a tree that encodes as the canonical form of the document', () => {
    const value = parseCanonicalJson(
      '{ "b" : [ 1e2 , "\\u00e9" ] , "a" : { "__proto__" : {} } }',
    );
    expect(canonicalize(value)).toBe('{"a":{"__proto__":{}},"b":[100,"é"]}');
    expect(Object.getPrototypeOf(value)).toBeNull();
  });
});
