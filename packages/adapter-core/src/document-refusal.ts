import { ProviderError } from './provider-error.js';

/**
 * How a too-large response came to be known as too large.
 *
 * - `declared`: its Content-Length said so, and no body was read. The header
 *   counts what is on the wire, so for a compressed response it is the
 *   compressed size.
 * - `streamed`: the body was read as it arrived and went over the limit. The
 *   read stopped there, so the number is where it stopped and not the size of
 *   the response, which may be far larger or not know its own length at all.
 * - `delivered`: a transport that has the whole body at once (a fixture).
 */
export type TooLargeBasis = 'declared' | 'streamed' | 'delivered';

const mebibytes = (bytes: number): string =>
  `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;

/**
 * A response went past the bound set for it, with the numbers the bound was
 * enforced on. The code is still `UPSTREAM_RESPONSE_TOO_LARGE`; what is new is
 * that a caller who knows what it asked for can say so (`about`) instead of
 * reporting "a response" that exceeded a number.
 */
export class ResponseTooLargeError extends ProviderError {
  constructor(
    readonly limitBytes: number,
    readonly observedBytes: number,
    readonly basis: TooLargeBasis,
    upstreamStatus?: number,
    readonly subject = 'Response',
  ) {
    super(
      'UPSTREAM_RESPONSE_TOO_LARGE',
      tooLargeMessage(subject, limitBytes, observedBytes, basis),
      upstreamStatus,
    );
    this.name = 'ResponseTooLargeError';
  }

  /** The same refusal, naming what was being read: `The packument of vite`. */
  about(subject: string): ResponseTooLargeError {
    return new ResponseTooLargeError(
      this.limitBytes,
      this.observedBytes,
      this.basis,
      this.upstreamStatus,
      subject,
    );
  }
}

function tooLargeMessage(
  subject: string,
  limit: number,
  observed: number,
  basis: TooLargeBasis,
): string {
  const bound = `${limit} bytes (${mebibytes(limit)})`;
  const seen = `${observed} bytes (${mebibytes(observed)})`;
  switch (basis) {
    case 'declared':
      return `${subject} declares ${seen} and exceeds the limit of ${bound}`;
    case 'delivered':
      return `${subject} is ${seen} and exceeds the limit of ${bound}`;
    case 'streamed':
      return `${subject} exceeds the limit of ${bound}: stopped reading at ${seen}`;
  }
}

/**
<<<<<<< ours
 * A metadata document held more values, or nested deeper, than the adapter
 * reads. The parser stops at the first value past the limit, and this says how
 * far it had got: `visited` values begun (the refused one included) in `offset`
 * of `documentLength` characters. A refusal that stopped at the limit has
 * built at most `maximum` values, however large the document claimed to be.
 */
export class MetadataLimitError extends ProviderError {
  constructor(
    readonly limit: 'values' | 'depth',
=======
 * A metadata document held more than the adapter reads: more values, nested
 * deeper, or a tree that would cost more to hold than the budget (`cost`, in
 * estimated bytes of heap; an object weighs more than a number). The parser
 * stops at the first part past the limit, and this says how far it had got:
 * `visited` values begun (the refused one included) in `offset` of
 * `documentLength` characters, with `spent` the cost charged by then. A refusal
 * that stopped at the limit has built no more than the limit, however large the
 * document claimed to be.
 */
export class MetadataLimitError extends ProviderError {
  constructor(
    readonly limit: 'values' | 'depth' | 'cost',
>>>>>>> theirs
    readonly maximum: number,
    readonly visited: number,
    readonly offset: number,
    readonly documentLength: number,
    message = limit === 'values'
      ? `Provider metadata exceeds ${maximum} values`
<<<<<<< ours
      : `Provider metadata exceeds depth ${maximum}`,
=======
      : limit === 'cost'
        ? `Provider metadata exceeds ${maximum} bytes of parsed size`
        : `Provider metadata exceeds depth ${maximum}`,
    /** What the tree had cost when the parser stopped; 0 when not counted. */
    readonly spent: number = 0,
>>>>>>> theirs
  ) {
    super('INVALID_PROVIDER_METADATA', message);
    this.name = 'MetadataLimitError';
  }

  /** The same refusal, naming what was being read: `The packument of vite`. */
  about(subject: string): MetadataLimitError {
    return new MetadataLimitError(
      this.limit,
      this.maximum,
      this.visited,
      this.offset,
      this.documentLength,
      `${subject} is not usable: ${this.message}`,
<<<<<<< ours
=======
      this.spent,
>>>>>>> theirs
    );
  }
}

/**
 * Whether an error is a refusal of the document a registry sent: too many
 * bytes, too many values, nested too deep, or not JSON at all. Unlike an
 * outage, it says something true about the document, so a caller that gives up
 * on it can say why. A network failure is not one.
 */
export function isDocumentRefusal(error: unknown): error is ProviderError {
  return (
    error instanceof ProviderError &&
    (error.code === 'UPSTREAM_RESPONSE_TOO_LARGE' ||
      error.code === 'INVALID_PROVIDER_METADATA')
  );
}
