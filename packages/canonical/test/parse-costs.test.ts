import { describe, expect, it } from 'vitest';
import {
  BIG_OBJECT_MEMBERS,
  CanonicalJsonLimitError,
  PARSE_COSTS,
  memberTableExcess,
  parseCanonicalJson,
  parseCanonicalJsonCosted,
} from '../src/index.js';

/**
 * A count of values cannot say what a tree costs: `1,` is two bytes and a slot,
 * `{},` three bytes and an object that takes about 200. The parser charges each
 * part by what it allocates, as it begins it, and stops at the part that would
 * pass the limit. What these hold is the arithmetic of the table, that a limit
 * on the cost stops the parse early and says where, and that the same logical
 * document costs more in a heavier encoding.
 */

const { peak, retained } = PARSE_COSTS;

const refusal = (text: string, maximumCost: number) => {
  try {
    parseCanonicalJson(text, { maximumCost });
  } catch (error) {
    return error as CanonicalJsonLimitError;
  }
  throw new Error('the document was accepted');
};

const costOf = (text: string) => parseCanonicalJsonCosted(text).cost;

describe('what each part costs', () => {
  it('charges nothing for a scalar that is not in a container', () => {
    expect(costOf('1')).toBe(0);
    expect(costOf('null')).toBe(0);
    expect(costOf('true')).toBe(0);
  });

  it('charges a string for its header and its characters, and two-byte text twice', () => {
    expect(costOf('"abcd"')).toBe(peak.string + 4 * peak.character);
    expect(costOf('"abcd"') < costOf('"€bcd"')).toBe(true);
    expect(costOf('"€bcd"')).toBe(peak.string + 4 * 2 * peak.character);
    // An escape is charged as two-byte text: it may decode to one.
    expect(costOf('"\\u0041bcd"')).toBe(peak.string + 9 * 2 * peak.character);
  });

  it('charges an object, and a member by its name', () => {
    expect(costOf('{}')).toBe(peak.object);
    expect(costOf('{"abcd":1}')).toBe(
      peak.object + peak.member + 4 * peak.nameCharacter,
    );
    expect(costOf('{"€bcd":1}')).toBe(
      peak.object + peak.member + 4 * 2 * peak.nameCharacter,
    );
  });

  it('charges an empty array its header and a full one a room for 17, then a slot a value', () => {
    expect(costOf('[]')).toBe(peak.array);
    expect(costOf('[1]')).toBe(peak.array + peak.element + peak.firstElement);
    expect(costOf('[1,1,1]')).toBe(
      peak.array + 3 * peak.element + peak.firstElement,
    );
  });

  it('charges a member of an object past the big-object count a further surcharge', () => {
    const members = (count: number) =>
      `{${Array.from({ length: count }, (_, i) => `"k${String(i).padStart(5, '0')}":1`).join(',')}}`;
    const each = peak.member + 6 * peak.nameCharacter;
    expect(costOf(members(BIG_OBJECT_MEMBERS))).toBe(
      peak.object +
        BIG_OBJECT_MEMBERS * each +
        memberTableExcess(BIG_OBJECT_MEMBERS),
    );
    expect(costOf(members(BIG_OBJECT_MEMBERS + 10))).toBe(
      peak.object +
        (BIG_OBJECT_MEMBERS + 10) * each +
        10 * peak.bigMember +
        memberTableExcess(BIG_OBJECT_MEMBERS + 10),
    );
  });

  it('charges an integer past what V8 keeps in a slot (2^30) as a heap number', () => {
    // A small integer is a tagged value in its slot; past 2^30 (2^31 on a
    // build without pointer compression) it is an object of its own.
    for (const small of ['1073741823', '-1073741824'])
      expect(costOf(`[${small}]`)).toBe(costOf('[1]'));
    for (const big of ['1073741824', '-1073741825', '9007199254740991'])
      expect(costOf(`[${big}]`)).toBe(costOf('[1]') + peak.heapNumber);
    expect(costOf('{"a":9007199254740991}')).toBe(
      costOf('{"a":1}') + peak.heapNumber,
    );
    expect(parseCanonicalJsonCosted('[9007199254740991]').retained).toBe(
      parseCanonicalJsonCosted('[1]').retained + retained.heapNumber,
    );
  });

  it('keeps a second table for what the finished tree keeps, below the peak', () => {
    const { retained: kept, cost } = parseCanonicalJsonCosted(
      '{"a":[1,2,{"b":"cd"}],"e":{}}',
    );
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(cost);
    for (const part of Object.keys(peak) as (keyof typeof peak)[])
      expect(retained[part], part).toBeLessThanOrEqual(peak[part]);
  });
});

describe('the cost limit', () => {
  it('refuses the part that would pass it, before it is built, and says where it stopped', () => {
    const dense = `[${'{},'.repeat(1_000_000)}{}]`;
    // The array, its first element and k objects with their slots.
    const limit =
      peak.array + peak.firstElement + 1000 * (peak.element + peak.object);
    const error = refusal(dense, limit);
    expect(error).toBeInstanceOf(CanonicalJsonLimitError);
    expect(error).toMatchObject({
      limit: 'cost',
      maximum: limit,
      message: `JSON document exceeds ${limit} bytes of parsed size`,
    });
    // The slot of one more object than fits was charged, so it is refused.
    expect(error.spent).toBeGreaterThan(limit);
    expect(error.spent).toBeLessThanOrEqual(limit + peak.element + peak.object);
    // The array, then a thousand objects.
    expect(error.visited).toBe(1001);
    // Three characters an object: the rest of three million was never read.
    expect(error.offset).toBeLessThan(3 * 1001 + 10);
  });

  it('accepts a document that costs exactly the limit', () => {
    const text = '{"a":[1,2],"b":"cd"}';
    const cost = costOf(text);
    expect(() => parseCanonicalJson(text, { maximumCost: cost })).not.toThrow();
    expect(refusal(text, cost - 1)).toMatchObject({ limit: 'cost' });
  });

  it('is not applied unless it is given, and stops a count and a depth as well', () => {
    expect(() =>
      parseCanonicalJson(`[${'{},'.repeat(10_000)}{}]`),
    ).not.toThrow();
    expect(() =>
      parseCanonicalJson('[[[1]]]', { maximumCost: 1e9, maximumDepth: 1 }),
    ).toThrow(expect.objectContaining({ limit: 'depth' }));
    expect(() =>
      parseCanonicalJson('[1,2,3]', { maximumCost: 1e9, maximumValues: 2 }),
    ).toThrow(expect.objectContaining({ limit: 'values' }));
  });

  it('is checked for a name before the value it holds is read', () => {
    // 2 MiB of name, then a document that is not JSON: the cost is refused first.
    const text = `{"${'k'.repeat(2 * 1024 * 1024)}":!!!}`;
    expect(refusal(text, 1000)).toMatchObject({ limit: 'cost' });
  });
});

describe('the same logical document in a heavier encoding', () => {
  // A thousand records of two numbers, written four ways.
  const records = 1000;
  const flat = `[${Array.from({ length: records }, () => '1,2').join(',')}]`;
  const pairs = `[${Array.from({ length: records }, () => '[1,2]').join(',')}]`;
  const named = `[${Array.from({ length: records }, () => '{"a":1,"b":2}').join(',')}]`;
  const longNames = `[${Array.from({ length: records }, () => '{"aaaaaaaaaaaaaaaaaaaa":1,"bbbbbbbbbbbbbbbbbbbb":2}').join(',')}]`;

  it('costs more the more it allocates for the same two numbers', () => {
    // As bare slots, then as the members of an object, then as members with
    // long names: each allocates more than the one before.
    const costs = [flat, named, longNames].map(costOf);
    expect(costs).toEqual([...costs].sort((a, b) => a - b));
    expect(new Set(costs).size).toBe(3);
    // An object with two members costs more than twice its two numbers as
    // bare slots (90 a slot against 240 and two members of 60).
    expect(costs[1]! / costs[0]!).toBeGreaterThan(2);
    // A pair of numbers in an array of its own is dearer than the same two
    // numbers as bare slots, since V8 gives a pushed-to array room for 17.
    expect(costOf(pairs)).toBeGreaterThan(costs[0]!);
  });

  it('is refused earlier, having read less of the text', () => {
    const limit = Math.round(costOf(named) * 0.6);
    // The lightest fits, the heavier are refused, each after fewer values.
    expect(() =>
      parseCanonicalJson(flat, { maximumCost: limit }),
    ).not.toThrow();
    const visits = [pairs, named, longNames].map((text) => {
      try {
        parseCanonicalJson(text, { maximumCost: limit });
      } catch (error) {
        return error as CanonicalJsonLimitError;
      }
      return undefined;
    });
    expect(visits[1]).toBeDefined();
    expect(visits[2]).toBeDefined();
    // The long names are charged by the character, so they stop sooner.
    expect(visits[2]!.visited).toBeLessThan(visits[1]!.visited);
    expect(visits[2]!.offset / longNames.length).toBeLessThan(
      visits[1]!.offset / named.length,
    );
  });

  it('charges two-byte text twice, so a name with one € is refused where the same name without is not', () => {
    const body = (name: string) =>
      `{${Array.from({ length: 2000 }, (_, i) => `"${name}${String(i).padStart(5, '0')}":1`).join(',')}}`;
    const narrow = body('aaaaaaaaaaaaaaaa');
    const wide = body('aaaaaaaaaaaaaaa€');
    const limit = costOf(narrow) + 1000;
    expect(() =>
      parseCanonicalJson(narrow, { maximumCost: limit }),
    ).not.toThrow();
    expect(refusal(wide, limit)).toMatchObject({ limit: 'cost' });
  });
});
