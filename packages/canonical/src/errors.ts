export class CanonicalJsonError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalJsonError';
  }
}

/**
 * What a document may hold, enforced while it is parsed. A parser that counts
 * after it has built the tree has already spent the memory the count was meant
 * to protect, so both limits stop the parse itself: the first value past the
 * limit is refused before it is built. Neither limit applies unless it is
 * given.
 */
export interface CanonicalParseLimits {
  /** Most values the document may hold: every scalar, array and object. */
  readonly maximumValues?: number;
  /** Deepest nesting allowed. The root is at depth 0. */
  readonly maximumDepth?: number;
}

/**
 * A document went past a `CanonicalParseLimits` bound. It says how far the
 * parser got, so a caller (and a test) can see that it stopped early rather
 * than that it finished and then counted.
 */
export class CanonicalJsonLimitError extends CanonicalJsonError {
  constructor(
    readonly limit: 'values' | 'depth',
    readonly maximum: number,
    /** Values begun when the parser stopped; the refused one is included. */
    readonly visited: number,
    /** Characters of the text consumed when the parser stopped. */
    readonly offset: number,
  ) {
    super(
      limit === 'values'
        ? `JSON document exceeds ${maximum} values`
        : `JSON document exceeds depth ${maximum}`,
    );
    this.name = 'CanonicalJsonLimitError';
  }
}
