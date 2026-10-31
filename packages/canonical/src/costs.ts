import type { CanonicalParseLimits } from './errors.js';

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
 *   is set in. The parser builds a `Set` of the names of each object, so the
 *   peak is above what the finished tree keeps, most of all for an object with
 *   a great many members. (The weights were fitted when the parse also encoded
 *   the tree again, which it no longer does; they are above what it needs now.)
 *   For each of the thirty-eight shapes the weights were fitted on, the cost
 *   is at least the heap the parse needed. An object of a few dozen members
 *   needed more until its dictionary was charged: V8 gives it up to three
 *   slots a member, and such a document at the limit needed 1.06 times its
 *   cost. The parser now charges that dictionary at its size beyond these
 *   weights (`member-table.ts`), and such a document needs about 0.54 of its
 *   cost (ADR 0044, "The member table charged"). A member named by an array
 *   index (`"7"`, `"1023"`) is an element, not a property, and V8 grows that
 *   store by its own rule; the parser charges it on top of these weights
 *   (`member-table.ts`, ADR 0044, "A member named by an array index").
 * - `retained` is what the finished tree keeps, for a holder that keeps trees
 *   (a resolve counts the packuments it holds by it). It is above what the
 *   tree kept for every real packument, for an object of every member count
 *   measured and for every index-named object measured (at least 1.30 times
 *   what the tree kept), and below it by up to 1.3 times for an array just
 *   past a growth step.
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

/**
 * The most a document may cost to parse for each byte a reader lets it have,
 * in the units of `PARSE_COSTS.peak` (ADR 0044, "Documents other than
 * packuments").
 *
 * A byte bound does not bound what a tree costs to build: `{},` is 3 bytes and
 * an object of 240 (110 a byte), and `{"1023":0},` is 11 bytes and an
 * elements store of 40 KB (3,694 a byte, `member-table.ts`). One megabyte of
 * the second ends a process with a heap of 1 GiB. The repository's own
 * documents, minified as they are sent (the goldens, the PREX pact, and
 * packslip's statements and bundles: 31 of them), cost 2.4 to 11.3 a byte, so
 * 16 a byte leaves a document at its byte bound 40 percent to spare and holds
 * whatever is sent in that many bytes to 16 times them
 * (`document-limits.test.ts` reads those documents again).
 */
export const DOCUMENT_COST_PER_BYTE = 16;

/**
 * The least a document may cost, whatever its bytes: a document of a few bytes
 * weighs more than sixteen times them (`{}` is 2 bytes and 240, `{"a":1}` 7
 * bytes and 304), so a bound of a few bytes, or an event decoded from the
 * bytes it is, still reads what it should.
 */
export const DOCUMENT_COST_FLOOR = 1024 * 1024;

/**
 * The parse limits for a document of at most `maximumBytes`: what a reader
 * passes `parseCanonicalJson` beside its byte bound, so that the tree is
 * bounded as the bytes are. A reader whose documents are known to be denser,
 * or larger than any byte bound it sets (an npm packument), states its own
 * limit instead.
 */
export function documentParseLimits(
  maximumBytes: number,
): CanonicalParseLimits & { readonly maximumCost: number } {
  return {
    maximumCost: Math.max(
      maximumBytes * DOCUMENT_COST_PER_BYTE,
      DOCUMENT_COST_FLOOR,
    ),
  };
}
