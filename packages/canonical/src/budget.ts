import {
  CanonicalJsonLimitError,
  type CanonicalParseLimits,
} from './errors.js';

/**
 * What a parse may still spend. The parser charges it as each value begins, so
 * the first value past a limit is refused before it is built and the work done
 * is set by the limit, not by the size of the document.
 */
export class ParseBudget {
  private visited = 0;
  private readonly maximumValues: number;
  private readonly maximumDepth: number;

  constructor(limits: CanonicalParseLimits) {
    this.maximumValues = limits.maximumValues ?? Number.POSITIVE_INFINITY;
    this.maximumDepth = limits.maximumDepth ?? Number.POSITIVE_INFINITY;
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
      );
    if (depth > this.maximumDepth)
      throw new CanonicalJsonLimitError(
        'depth',
        this.maximumDepth,
        this.visited,
        offset,
      );
  }
}
