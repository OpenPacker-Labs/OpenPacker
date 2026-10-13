/**
 * What building each part of a parsed document costs, in bytes of heap.
 *
 * A count of values says little about what a document costs to hold: `1,` is
 * two bytes and a slot in an array, `{},` is three bytes and a dictionary-mode
 * object that takes about 200 to build. The parser charges each part as it
 * begins it, so a document is refused when the tree it is building would cost
 * more than the limit and not after it has built it.
 *
 * Two tables, both measured (ADR 0044, "A budget that weighs what a tree
 * allocates"; the method and the figures are there):
 *
 * - `peak` is what the parse needs while it builds the tree. It is what a limit
 *   is set in. The parser builds a `Set` of the names of each object and
 *   validates the tree by encoding it again, so the peak is above what the
 *   finished tree keeps, most of all for an object with a great many members.
 *   For every shape measured, the cost is at least the heap the parse needed.
 * - `retained` is what the finished tree keeps, for a holder that keeps trees
 *   (a resolve counts the packuments it holds by it). For every document
 *   measured it is within 50 percent of the heap the tree kept, above it for
 *   every real packument.
 *
 * Nothing here is a V8 constant; they are what a build of Node 22 measured, and
 * `canonical/test/parse-costs.test.ts` measures them again.
 */
export interface ParseCostTable {
  /** An object, with the dictionary and the set of names it is built with. */
  readonly object: number;
  /** An array. */
  readonly array: number;
  /** The first element of an array: V8 gives a pushed-to array room for 17. */
  readonly firstElement: number;
  /** Each element of an array. */
  readonly element: number;
  /** Each object member, with its value's slot. */
  readonly member: number;
  /** Each member of an object past `BIG_OBJECT_MEMBERS`, which has a table to grow. */
  readonly bigMember: number;
  /** Each character of a member name, as one-byte text (two-byte text costs twice). */
  readonly nameCharacter: number;
  /** A string value. */
  readonly string: number;
  /** Each character of a string value, as one-byte text (two-byte text costs twice). */
  readonly character: number;
}

/** Members an object holds before each further one costs `bigMember` more. */
export const BIG_OBJECT_MEMBERS = 4096;

export interface ParseCosts {
  readonly peak: ParseCostTable;
  readonly retained: ParseCostTable;
}

export const PARSE_COSTS: ParseCosts = Object.freeze({
  peak: Object.freeze({
    object: 240,
    array: 64,
    firstElement: 150,
    element: 90,
    member: 60,
    bigMember: 400,
    nameCharacter: 3.5,
    string: 50,
    character: 2,
  }),
  retained: Object.freeze({
    object: 195,
    array: 40,
    firstElement: 150,
    element: 9,
    member: 40,
    bigMember: 45,
    nameCharacter: 1,
    string: 24,
    character: 1,
  }),
});
