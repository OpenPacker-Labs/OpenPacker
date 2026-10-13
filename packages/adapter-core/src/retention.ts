/**
 * What a resolve may keep of the registry documents it has read.
 *
 * Every document a resolve reads is kept so that a package referenced from ten
 * places is fetched and parsed once. That is a bound on requests and not on
 * memory: a registry that has the walk visit enough large packuments can make
 * the client hold as much as it likes. This is the accountant for the
 * memory: holders say what they keep and what it costs, and when the total
 * passes the budget the least recently used are told to let go.
 *
 * A holder lets go only of what it can get again. A transport says so by
 * `refetchable`; a ledger that is asked to keep what cannot be fetched again is
 * given an unlimited budget by whoever builds it, never an eviction that loses
 * the document.
 */

/** The default for a resolve: 256 MiB of packument text and parsed objects. */
export const DEFAULT_RETAINED_BYTES = 256 * 1024 * 1024;

/** Asked of a holder when its entry is the least recently used over budget. */
export type Release = () => void;

interface Held {
  readonly bytes: number;
  readonly release: Release;
}

export class RetentionLedger {
  /** Least recently used first: a `Map` iterates in insertion order. */
  readonly #held = new Map<string, Held>();
  #retained = 0;
  #evictions = 0;
  #peak = 0;

  /**
   * @param maximumBytes What may be retained. `Infinity` keeps everything and
   * `0` keeps nothing: every entry is released as it is registered.
   */
  constructor(readonly maximumBytes: number = DEFAULT_RETAINED_BYTES) {
    if (Number.isNaN(maximumBytes) || maximumBytes < 0)
      throw new RangeError('A retention budget is zero or more bytes');
  }

  /** Bytes held now, as the holders counted them. */
  get retainedBytes(): number {
    return this.#retained;
  }

  /** The most `retainedBytes` was at any instant, evictions not yet made. */
  get peakBytes(): number {
    return this.#peak;
  }

  get entries(): number {
    return this.#held.size;
  }

  /** How many entries have been released to stay within the budget. */
  get evictions(): number {
    return this.#evictions;
  }

  has(key: string): boolean {
    return this.#held.has(key);
  }

  /**
   * Hold `key` at `bytes` as the most recently used, replacing what the key
   * held, and release the least recently used until the total is within the
   * budget. The new entry is released too when it alone is over it, so after
   * this call the total never exceeds the budget; while the entry is being
   * built the holder has it and the ledger does not, which is the one document
   * over the budget that a resolve can have in flight.
   */
  retain(key: string, bytes: number, release: Release): void {
    if (!Number.isFinite(bytes) || bytes < 0)
      throw new RangeError('A retained entry weighs zero or more bytes');
    const before = this.#held.get(key);
    if (before !== undefined) {
      this.#held.delete(key);
      this.#retained -= before.bytes;
    }
    this.#held.set(key, { bytes, release });
    this.#retained += bytes;
    if (this.#retained > this.#peak) this.#peak = this.#retained;
    this.enforce();
  }

  /** Mark `key` as used now, so it is released last. */
  touch(key: string): void {
    const entry = this.#held.get(key);
    if (entry === undefined) return;
    this.#held.delete(key);
    this.#held.set(key, entry);
  }

  /** The holder dropped `key` itself; nothing is released. */
  forget(key: string): void {
    const entry = this.#held.get(key);
    if (entry === undefined) return;
    this.#held.delete(key);
    this.#retained -= entry.bytes;
  }

  private enforce(): void {
    while (this.#retained > this.maximumBytes) {
      const oldest = this.#held.entries().next();
      if (oldest.done) return;
      const [key, entry] = oldest.value;
      this.#held.delete(key);
      this.#retained -= entry.bytes;
      this.#evictions += 1;
      entry.release();
    }
  }
}
