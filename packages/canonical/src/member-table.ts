import { BIG_OBJECT_MEMBERS } from './costs.js';

/**
 * The member table of an object the parser builds.
 *
 * Every object is made with `Object.create(null)`, which V8 keeps in
 * dictionary mode: its members are entries of a hash table of a power of two of
 * entries, at least one and a half times the members and at least 4, of 24
 * bytes each (name, value, details). Just past a step that is nearly three
 * entries a member: 32 for 21 members, 64 for 22. The flat weights do not see
 * this; an object of 86 members held 1.64 times what they said. Measured for 0
 * to 128 members: `canonical/test/member-tables.json`.
 */

/** Bytes of one entry of the table. */
export const MEMBER_TABLE_ENTRY = 24;

/** The entries of an empty object's table, which the object's weight pays for. */
export const EMPTY_MEMBER_TABLE = 4;

/**
 * What a member's own weight pays toward the table: 16 of its 40 retained
 * bytes, the rest being the header of its name (a string of its own when the
 * name is not shared); past `BIG_OBJECT_MEMBERS`, 61, with the surcharge.
 */
export const MEMBER_TABLE_CREDIT = 16;
export const BIG_MEMBER_TABLE_CREDIT = 61;

/** The entries V8 gives the table of an object of `members` members. */
export function memberTableEntries(members: number): number {
  const needed = members + Math.floor(members / 2);
  return needed <= EMPTY_MEMBER_TABLE
    ? EMPTY_MEMBER_TABLE
    : 2 ** (32 - Math.clz32(needed - 1));
}

/**
 * What the table of an object of `members` members costs beyond what the
 * object's weight and its members' weights already pay for it. The parser
 * charges the difference as each member is added, so an object costs at least
 * its table at every count.
 */
export function memberTableExcess(members: number): number {
  const paid =
    MEMBER_TABLE_CREDIT * Math.min(members, BIG_OBJECT_MEMBERS) +
    BIG_MEMBER_TABLE_CREDIT * Math.max(0, members - BIG_OBJECT_MEMBERS);
  return Math.max(
    0,
    MEMBER_TABLE_ENTRY * (memberTableEntries(members) - EMPTY_MEMBER_TABLE) -
      paid,
  );
}
