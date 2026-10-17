import {
  CanonicalJsonLimitError,
  type CanonicalParseLimits,
} from './errors.js';
import {
  BIG_OBJECT_MEMBERS,
  PARSE_COSTS,
  SMALL_INTEGER_LIMIT,
} from './costs.js';
import { memberTableExcess } from './member-table.js';

/**
 * What a parse may still spend. The parser charges it as each part of the tree
 * begins, so the first part past a limit is refused before it is built and the
 * work done is set by the limit, not by the size of the document.
 *
 * Three things are limited, and any of them stops the parse: how many values
 * (every scalar, array and object), how deep, and what the tree costs
 * (`PARSE_COSTS.peak`: an object is dearer than a number, a long name than a
 * short one). The cost is the one that follows memory; the count and the depth
 * are for callers that want those.
 */
export class ParseBudget {
  private visited = 0;
  private spent = 0;
  private kept = 0;
  private readonly maximumValues: number;
  private readonly maximumDepth: number;
  private readonly maximumCost: number;

  constructor(limits: CanonicalParseLimits) {
    this.maximumValues = limits.maximumValues ?? Number.POSITIVE_INFINITY;
    this.maximumDepth = limits.maximumDepth ?? Number.POSITIVE_INFINITY;
    this.maximumCost = limits.maximumCost ?? Number.POSITIVE_INFINITY;
  }

  /** What the tree cost to build, in the units of `PARSE_COSTS.peak`. */
  get cost(): number {
    return this.spent;
  }

  /** What the tree built so far keeps, in the units of `PARSE_COSTS.retained`. */
  get retained(): number {
    return this.kept;
  }

  /** A value is about to begin at `offset`, `depth` levels down. */
  begin(depth: number, offset: number): void {
    this.visited += 1;
    if (this.visited > this.maximumValues)
      throw new CanonicalJsonLimitError(
        'values',
        this.maximumValues,
        this.visited,
        offset,
        this.spent,
      );
    if (depth > this.maximumDepth)
      throw new CanonicalJsonLimitError(
        'depth',
        this.maximumDepth,
        this.visited,
        offset,
        this.spent,
      );
  }

  /** The value that began is an object. */
  object(offset: number): void {
    this.charge(PARSE_COSTS.peak.object, PARSE_COSTS.retained.object, offset);
  }

  /** The value that began is an array. */
  array(offset: number): void {
    this.charge(PARSE_COSTS.peak.array, PARSE_COSTS.retained.array, offset);
  }

  /** An element of an array is about to begin; `index` is its place. */
  element(index: number, offset: number): void {
    const first = index === 0;
    this.charge(
      PARSE_COSTS.peak.element + (first ? PARSE_COSTS.peak.firstElement : 0),
      PARSE_COSTS.retained.element +
        (first ? PARSE_COSTS.retained.firstElement : 0),
      offset,
    );
  }

  /** The value that began is the integer `value`. */
  number(value: number, offset: number): void {
    if (value < -SMALL_INTEGER_LIMIT || value >= SMALL_INTEGER_LIMIT)
      this.charge(
        PARSE_COSTS.peak.heapNumber,
        PARSE_COSTS.retained.heapNumber,
        offset,
      );
  }

  /**
   * A string of `length` characters is about to be built: the name of the
   * `member`th member of an object or, with none, a value.
   */
  text(
    member: number | undefined,
    length: number,
    wide: boolean,
    offset: number,
  ): void {
    if (member === undefined) this.string(length, wide, offset);
    else this.member(member, length, wide, offset);
  }

  /**
   * The value that began is a string of `length` characters; two-byte text
   * costs two bytes a character.
   */
  string(length: number, wide: boolean, offset: number): void {
    const width = wide ? 2 : 1;
    this.charge(
      PARSE_COSTS.peak.string + length * width * PARSE_COSTS.peak.character,
      PARSE_COSTS.retained.string +
        length * width * PARSE_COSTS.retained.character,
      offset,
    );
  }

  /**
   * An object member whose name is `length` characters, the `index`th of its
   * object, before its value.
   */
  member(index: number, length: number, wide: boolean, offset: number): void {
    const width = wide ? 2 : 1;
    const big = index >= BIG_OBJECT_MEMBERS;
    // The object's member table as it grows to hold this member, beyond what
    // the weights pay for it (`member-table.ts`); it can fall back between
    // steps, as the members' own weights catch up with the table.
    const table = memberTableExcess(index + 1) - memberTableExcess(index);
    this.charge(
      PARSE_COSTS.peak.member +
        (big ? PARSE_COSTS.peak.bigMember : 0) +
        length * width * PARSE_COSTS.peak.nameCharacter +
        table,
      PARSE_COSTS.retained.member +
        (big ? PARSE_COSTS.retained.bigMember : 0) +
        length * width * PARSE_COSTS.retained.nameCharacter +
        table,
      offset,
    );
  }

  private charge(peak: number, retained: number, offset: number): void {
    this.spent += peak;
    this.kept += retained;
    if (this.spent > this.maximumCost)
      throw new CanonicalJsonLimitError(
        'cost',
        this.maximumCost,
        this.visited,
        offset,
        this.spent,
      );
  }
}
