import { describe, expect, it } from 'vitest';
<<<<<<< ours
=======
import { PARSE_COSTS } from '@openpacker/canonical';
>>>>>>> theirs
import {
  MetadataLimitError,
  ProviderError,
  json,
<<<<<<< ours
=======
  jsonWithCost,
>>>>>>> theirs
  type HttpResponse,
} from './index.js';

/**
 * The limit on what a parsed document may hold is enforced while it is parsed.
 * A registry's response is bounded in bytes before it is read, but a byte
 * bound says little about how many values it holds: `{},` is three bytes and
 * an object. These tests hold the parser to stopping at the limit, which they
 * see in `visited` and `offset`, not in how long it took.
 */

const encoder = new TextEncoder();

const respond = (text: string): HttpResponse => ({
  status: 200,
  headers: {},
  body: encoder.encode(text),
  url: 'https://registry.test/x',
});

/** What `json` threw, or fails the test by returning. */
function refused(text: string, limits?: Parameters<typeof json>[1]) {
  try {
    json(respond(text), limits);
  } catch (error) {
    return error as MetadataLimitError;
  }
  throw new Error('the document was accepted');
}

describe('the default limits', () => {
  it('refuse a dense document at 200,000 values, having built that many and no more', () => {
    const dense = `[${'{},'.repeat(1_000_000)}{}]`;
    const error = refused(dense);
    expect(error).toBeInstanceOf(MetadataLimitError);
    expect(error).toMatchObject({
      code: 'INVALID_PROVIDER_METADATA',
      message: 'Provider metadata exceeds 200000 values',
      limit: 'values',
      maximum: 200_000,
      visited: 200_001,
      documentLength: dense.length,
    });
    // A fifth of the document at most: the rest was never read.
    expect(error.offset).toBeLessThan(dense.length / 4);
  });

  it('refuse nesting past 64 without recursing into it', () => {
    const error = refused('['.repeat(500_000));
    expect(error).toMatchObject({
      code: 'INVALID_PROVIDER_METADATA',
      message: 'Provider metadata exceeds depth 64',
      limit: 'depth',
      maximum: 64,
    });
  });

  it('accept a document inside them', () => {
    expect(json<number[]>(respond(`[${'1,'.repeat(150_000)}1]`))).toHaveLength(
      150_001,
    );
  });
});

describe('limits a caller states', () => {
  it('replace the defaults, and the first value past them is the refused one', () => {
    const body = `[${'1,'.repeat(299_999)}1]`;
    // 300,000 numbers and the array.
    expect(
      json<number[]>(respond(body), { maximumNodes: 300_001 }),
    ).toHaveLength(300_000);
    expect(refused(body, { maximumNodes: 300_000 })).toMatchObject({
      message: 'Provider metadata exceeds 300000 values',
      visited: 300_001,
    });
  });

  it('can allow more depth', () => {
    // A hundred arrays, the innermost at depth 99.
    const nested = '['.repeat(100) + ']'.repeat(100);
    expect(() => json(respond(nested), { maximumDepth: 99 })).not.toThrow();
    expect(refused(nested, { maximumDepth: 98 })).toMatchObject({
      limit: 'depth',
      maximum: 98,
    });
  });
});

describe('a document that is not a bounded one is not a limit', () => {
  it("reports malformed JSON as invalid metadata, with the parser's words", () => {
    expect(() => json(respond('{"a":'))).toThrow(ProviderError);
    expect(() => json(respond('{"a":'))).toThrow(/Expected a JSON value/);
    const error = (() => {
      try {
        json(respond('[1,,2]'));
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).not.toBeInstanceOf(MetadataLimitError);
    expect(error).toMatchObject({ code: 'INVALID_PROVIDER_METADATA' });
  });
});
<<<<<<< ours
=======

describe('a limit on what the tree costs', () => {
  const { peak } = PARSE_COSTS;

  it('refuses a dense document as soon as the tree would cost more, having built only what fits', () => {
    const dense = `[${'{},'.repeat(1_000_000)}{}]`;
    const maximumCost =
      100 * (peak.element + peak.object) + peak.array + peak.firstElement;
    const error = refused(dense, { maximumCost });
    expect(error).toBeInstanceOf(MetadataLimitError);
    expect(error).toMatchObject({
      code: 'INVALID_PROVIDER_METADATA',
      limit: 'cost',
      maximum: maximumCost,
      message: `Provider metadata exceeds ${maximumCost} bytes of parsed size`,
      // The array and a hundred objects were built; the next one's slot was refused.
      visited: 101,
      documentLength: dense.length,
    });
    expect(error.spent).toBeGreaterThan(maximumCost);
    expect(error.spent).toBeLessThanOrEqual(
      maximumCost + peak.element + peak.object,
    );
    expect(error.offset).toBeLessThan(400);
  });

  it('weighs an object more than a number: the same count of values is refused as objects and not as numbers', () => {
    const count = 20_000;
    const numbers = `[${'1,'.repeat(count - 1)}1]`;
    const objects = `[${'{},'.repeat(count - 1)}{}]`;
    const maximumCost = 2_000_000;
    expect(json<number[]>(respond(numbers), { maximumCost })).toHaveLength(
      count,
    );
    expect(refused(objects, { maximumCost })).toMatchObject({ limit: 'cost' });
  });

  it('does not apply the default count of values unless a count is also given', () => {
    const wide = `[${'1,'.repeat(299_999)}1]`;
    expect(() => json(respond(wide))).toThrow(/exceeds 200000 values/u);
    expect(json<number[]>(respond(wide), { maximumCost: 1e9 })).toHaveLength(
      300_000,
    );
    expect(
      refused(wide, { maximumCost: 1e9, maximumNodes: 1000 }),
    ).toMatchObject({ limit: 'values', maximum: 1000 });
  });

  it('says what the tree cost, and what it keeps, which is less', () => {
    const { value, cost, retained } = jsonWithCost<unknown[]>(
      respond('[{"a":"bc"},[1],{}]'),
      { maximumCost: 1e6 },
    );
    expect(value).toHaveLength(3);
    expect(cost).toBeGreaterThan(0);
    expect(retained).toBeGreaterThan(0);
    expect(retained).toBeLessThan(cost);
  });
});
>>>>>>> theirs
