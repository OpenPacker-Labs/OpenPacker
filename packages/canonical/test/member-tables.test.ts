import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BIG_OBJECT_MEMBERS,
  EMPTY_MEMBER_TABLE,
  MEMBER_TABLE_ENTRY,
  PARSE_COSTS,
  memberTableEntries,
  memberTableExcess,
  parseCanonicalJsonCosted,
} from '../src/index.js';

/**
 * An object's members are a hash table V8 rounds up to a power of two, at least
 * one and a half times the members: nearly three entries a member just past a
 * step. `member-tables.json` is what an object of 0 to 128 members kept,
 * measured; the model must say the same table at every count, and the parser
 * must charge at least that table, in what an object costs and in what it is
 * estimated to keep.
 */

const fixture = JSON.parse(
  readFileSync(new URL('./member-tables.json', import.meta.url), 'utf8'),
) as { rows: [members: number, keptBytes: number, entries: number][] };

const name = (j: number) =>
  j < 26
    ? String.fromCharCode(97 + j)
    : String.fromCharCode(97 + (j % 26)) +
      String.fromCharCode(97 + Math.floor(j / 26));
const object = (members: number) =>
  `{${Array.from({ length: members }, (_, j) => `"${name(j)}":1`).join(',')}}`;

describe("an object's member table", () => {
  it('has the entries V8 gave it, at every count measured', () => {
    expect(fixture.rows).toHaveLength(129);
    for (const [members, , entries] of fixture.rows)
      expect(memberTableEntries(members), `${members} members`).toBe(entries);
  });

  it('grows at these steps, and is 24 bytes an entry', () => {
    const steps = fixture.rows
      .filter(([members]) => members > 0)
      .filter(
        ([members, , entries]) => memberTableEntries(members - 1) !== entries,
      )
      .map(([members, , entries]) => [members, entries]);
    expect(steps).toEqual([
      [4, 8],
      [6, 16],
      [12, 32],
      [22, 64],
      [44, 128],
      [86, 256],
    ]);
    const [, empty] = fixture.rows[0]!;
    for (const [members, kept, entries] of fixture.rows)
      expect(
        Math.abs(
          kept - empty - MEMBER_TABLE_ENTRY * (entries - EMPTY_MEMBER_TABLE),
        ),
        `${members} members`,
      ).toBeLessThan(12);
  });

  it('is charged beyond what the object and its members pay, as each member is added', () => {
    const { peak } = PARSE_COSTS;
    for (const members of [3, 4, 21, 22, 86])
      expect(parseCanonicalJsonCosted(object(members)).cost).toBe(
        peak.object +
          members * peak.member +
          [...Array(members).keys()].reduce(
            (sum, j) => sum + name(j).length * peak.nameCharacter,
            0,
          ) +
          memberTableExcess(members),
      );
    // An object of 86 members, whose table is 256 entries.
    expect(memberTableExcess(86)).toBe(24 * 252 - 16 * 86);
    expect(memberTableExcess(3)).toBe(0);
  });

  it('is estimated at or above what an object kept, at every count measured', () => {
    const empty = parseCanonicalJsonCosted('[]').retained;
    for (const [members, kept] of fixture.rows) {
      const retained =
        parseCanonicalJsonCosted(`[${object(members)}]`).retained -
        empty -
        PARSE_COSTS.retained.firstElement;
      expect(retained, `${members} members`).toBeGreaterThanOrEqual(kept);
    }
  });

  it('is paid for mostly by the surcharge in an object of many members', () => {
    // Just past the big-object count the table has doubled (8,192 entries)
    // before the surcharge has paid for much of it; far past, it has.
    expect(memberTableExcess(BIG_OBJECT_MEMBERS + 1)).toBe(
      24 * (8192 - 4) - 16 * BIG_OBJECT_MEMBERS - 61,
    );
    for (const members of [100_000, 1_000_000])
      expect(memberTableExcess(members)).toBeLessThan(members * 4);
  });
});
