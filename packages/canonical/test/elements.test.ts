import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  FIRST_INDEX_MEMBER,
  INDEX_MEMBER,
  PARSE_COSTS,
  isArrayIndex,
  parseCanonicalJsonCosted,
} from '../src/index.js';

/**
 * A member named by an array index (`"1023"`) is not in an object's member
 * table: V8 keeps it as an element, and the first such member below 1,024 gives
 * the object a store of up to 5,000 slots of 8 bytes, whatever few members it
 * holds. `elements.json` is what objects of such members kept, measured; the
 * parser must charge at least that, in what an object costs and in what it is
 * estimated to keep.
 */

type IndexNames = { names: string[] } | { gap: number; count: number };

const fixture = JSON.parse(
  readFileSync(new URL('./elements.json', import.meta.url), 'utf8'),
) as { rows: [spec: IndexNames, keptBytes: number][] };

const namesOf = (spec: IndexNames) =>
  'names' in spec
    ? spec.names
    : Array.from({ length: spec.count }, (_, i) => String(i * spec.gap));
const object = (spec: IndexNames) =>
  `{${namesOf(spec)
    .map((name) => `"${name}":0`)
    .join(',')}}`;

describe('a member named by an array index', () => {
  it('is an index exactly when V8 makes it an element', () => {
    for (const name of ['0', '7', '1023', '4294967294'])
      expect(isArrayIndex(name), name).toBe(true);
    for (const name of ['', '01', '-1', '1.0', '1e3', ' 1', '4294967295', 'a1'])
      expect(isArrayIndex(name), name).toBe(false);
  });

  it('is charged the store the first one may make, and its share of one past it', () => {
    const named = parseCanonicalJsonCosted('{"abcd":0}').cost;
    expect(parseCanonicalJsonCosted('{"1023":0}').cost).toBe(
      named + FIRST_INDEX_MEMBER + INDEX_MEMBER,
    );
    // An escaped name is the same name: `\u0031` is "1", `\u0061` is "a".
    expect(parseCanonicalJsonCosted('{"\\u0031":0}').cost).toBe(
      parseCanonicalJsonCosted('{"\\u0061":0}').cost +
        FIRST_INDEX_MEMBER +
        INDEX_MEMBER,
    );
    const two = parseCanonicalJsonCosted('{"1023":0,"2575":0}');
    expect(two.cost).toBe(
      parseCanonicalJsonCosted('{"abcd":0,"efgh":0}').cost +
        FIRST_INDEX_MEMBER +
        2 * INDEX_MEMBER,
    );
  });

  it('is charged at or above what an object kept, for every spec measured', () => {
    const empty = parseCanonicalJsonCosted('[]');
    for (const [spec, kept] of fixture.rows) {
      const parsed = parseCanonicalJsonCosted(`[${object(spec)}]`);
      const label = JSON.stringify(spec).slice(0, 60);
      expect(
        parsed.retained - empty.retained - PARSE_COSTS.retained.firstElement,
        label,
      ).toBeGreaterThanOrEqual(kept);
      expect(
        parsed.cost - empty.cost - PARSE_COSTS.peak.firstElement,
        label,
      ).toBeGreaterThanOrEqual(kept);
    }
  });
});
