import { describe, expect, it } from 'vitest';
import {
  CanonicalJsonError,
  CanonicalJsonLimitError,
  parseCanonicalJson,
} from '../src/index.js';

/**
 * A limit that is checked after the tree is built has already let the tree be
 * built. These limits are checked as the parser goes, so what a hostile
 * document costs is set by the limit and not by the document: `visited` and
 * `offset` say how far the parser got, and a document of millions of values
 * is refused after the first few.
 */

const refusal = (
  text: string,
  limits: Parameters<typeof parseCanonicalJson>[1],
) => {
  try {
    parseCanonicalJson(text, limits);
  } catch (error) {
    return error as CanonicalJsonLimitError;
  }
  throw new Error('the document was accepted');
};

describe('the value limit', () => {
  it('counts every scalar, array and object, the root included', () => {
    // [1,1,1] is the array and three numbers.
    expect(parseCanonicalJson('[1,1,1]', { maximumValues: 4 })).toEqual([
      1, 1, 1,
    ]);
    const error = refusal('[1,1,1]', { maximumValues: 3 });
    expect(error).toBeInstanceOf(CanonicalJsonLimitError);
    expect(error).toMatchObject({ limit: 'values', maximum: 3, visited: 4 });
  });

  it('counts an object member by its value, not its name', () => {
    expect(
      parseCanonicalJson('{"a":1,"b":{"c":2}}', { maximumValues: 4 }),
    ).toEqual({ a: 1, b: { c: 2 } });
    expect(refusal('{"a":1,"b":{"c":2}}', { maximumValues: 3 })).toMatchObject({
      visited: 4,
    });
  });

  it('is a canonical JSON error, so existing handlers keep catching it', () => {
    expect(refusal('[1,2]', { maximumValues: 1 })).toBeInstanceOf(
      CanonicalJsonError,
    );
  });

  it('stops at the first value past the limit, however much follows', () => {
    // 3,000,001 characters and 1,000,001 values; the parser reads a thousand.
    const dense = `[${'{},'.repeat(1_000_000)}{}]`;
    const error = refusal(dense, { maximumValues: 1000 });
    expect(error).toMatchObject({
      limit: 'values',
      maximum: 1000,
      visited: 1001,
    });
    // The `[`, then three characters for each of the 999 `{},` before the
    // element that was refused.
    expect(error.offset).toBe(1 + 3 * 999);
    expect(error.offset).toBeLessThan(dense.length / 100);
  });

  it('is not applied unless it is given', () => {
    const wide = `[${'1,'.repeat(300_000)}1]`;
    expect(parseCanonicalJson<number[]>(wide)).toHaveLength(300_001);
  });

  it('leaves a malformed document to say what is wrong with it', () => {
    expect(() => parseCanonicalJson('[1,,2]', { maximumValues: 100 })).toThrow(
      /Expected a JSON value/,
    );
  });
});

describe('the depth limit', () => {
  it('allows the depth it names and refuses one more', () => {
    const nested = (depth: number) => '['.repeat(depth) + ']'.repeat(depth);
    // The root is depth 0, so `[[]]` is two deep and its inner array depth 1.
    expect(() =>
      parseCanonicalJson(nested(2), { maximumDepth: 1 }),
    ).not.toThrow();
    expect(refusal(nested(3), { maximumDepth: 1 })).toMatchObject({
      limit: 'depth',
      maximum: 1,
    });
  });

  it('refuses a document nested a million deep by its depth, not by overflowing the stack', () => {
    const error = refusal('['.repeat(1_000_000), { maximumDepth: 64 });
    expect(error).toBeInstanceOf(CanonicalJsonLimitError);
    expect(error).toMatchObject({ limit: 'depth', maximum: 64, visited: 66 });
    // Without a limit the same text is a RangeError from the recursion.
    expect(() => parseCanonicalJson('['.repeat(1_000_000))).toThrow(RangeError);
  });
});
