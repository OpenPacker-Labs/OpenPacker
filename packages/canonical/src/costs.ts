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
 *   For each of the thirty-eight shapes the weights were fitted on, the cost
 *   is at least the heap the parse needed. An object of a few dozen members
 *   can need more: V8 gives its dictionary up to three slots a member, and
 *   such a document at the limit needed up to 1.2 times its cost (ADR 0044,
 *   "Shapes found since").
 * - `retained` is what the finished tree keeps, for a holder that keeps trees
 *   (a resolve counts the packuments it holds by it). It is above what the
 *   tree kept for every real packument, and below it by up to 1.6 times for
 *   such an object and 1.3 times for an array just past a growth step.
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
  /**
   * An integer past what V8 keeps in a slot, below -2^30 or from 2^30 on (the
   * small-integer range of a build with pointer compression; 2^31 without):
   * an object of its own, and its digits written again when the tree is
   * checked.
   */
  readonly heapNumber: number;
}

/** The integers V8 keeps in a slot on every build: from -2^30 to 2^30 - 1. */
export const SMALL_INTEGER_LIMIT = 2 ** 30;

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
    heapNumber: 150,
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
    heapNumber: 16,
  }),
});
