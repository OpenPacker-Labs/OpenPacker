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
 *
 * One document can have two holders: the memo keeps the response, and the
 * provider the objects parsed from it and the same bytes. An entry that names
 * the bytes it holds (`shares`) takes in an earlier entry naming the same ones,
 * so the bytes are counted once and the two are let go together: letting go of
 * the memo's alone would free nothing, and would send the provider's next use
 * of a document it still holds to the origin.
 */

/** The default for a resolve: 256 MiB of packument text and parsed objects. */
export const DEFAULT_RETAINED_BYTES = 256 * 1024 * 1024;

/** Asked of a holder when its entry is the least recently used over budget. */
export type Release = () => void;

export interface RetainOptions {
  /** The bytes this entry's memory is, by identity: a response's body. */
  readonly shares?: Uint8Array;
  /**
   * Take the entry back after it was let go, because what it held is held
   * again by the entry that takes it in and costs nothing more; false when the
   * holder has since answered otherwise.
   */
  readonly reclaim?: () => boolean;
}

interface Held extends RetainOptions {
  readonly bytes: number;
  readonly release: Release;
  /** Entries taken in: counted in this one, and released with it. */
  readonly members: Map<string, Held>;
}

export class RetentionLedger {
  /** Least recently used first: a `Map` iterates in insertion order. */
  readonly #held = new Map<string, Held>();
  /** The entry that took each member in. */
  readonly #ownerOf = new Map<string, string>();
  /** The entry, not a member, that holds each body now. */
  readonly #holderOf = new WeakMap<Uint8Array, string>();
  /** Entries let go that can be taken back, by what they held. */
  readonly #letGo = new WeakMap<Uint8Array, { key: string; held: Held }>();
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

  /** Keys held, members of another entry included. */
  get entries(): number {
    return this.#held.size + this.#ownerOf.size;
  }

  /** How many entries have been released to stay within the budget. */
  get evictions(): number {
    return this.#evictions;
  }

  has(key: string): boolean {
    return this.#held.has(key) || this.#ownerOf.has(key);
  }

  /**
   * Hold `key` at `bytes` as the most recently used, replacing what the key
   * held, and release the least recently used until the total is within the
   * budget. The new entry is released too when it alone is over it, so after
   * this call the total never exceeds the budget; while the entry is being
   * built the holder has it and the ledger does not, which is the one document
   * over the budget that a resolve can have in flight.
   */
  retain(
    key: string,
    bytes: number,
    release: Release,
    options: RetainOptions = {},
  ): void {
    if (!Number.isFinite(bytes) || bytes < 0)
      throw new RangeError('A retained entry weighs zero or more bytes');
    this.detach(key);
    const before = this.#held.get(key);
    const members = new Map<string, Held>();
    if (before !== undefined) {
      this.remove(key, before);
      for (const [member, held] of before.members)
        if (before.shares === options.shares) members.set(member, held);
        else this.restore(member, held);
    }
    const entry: Held = { ...options, bytes, release, members };
    if (options.shares !== undefined) this.takeIn(key, entry, options.shares);
    this.#held.set(key, entry);
    for (const member of members.keys()) this.#ownerOf.set(member, key);
    if (options.shares !== undefined) this.#holderOf.set(options.shares, key);
    this.#retained += bytes;
    if (this.#retained > this.#peak) this.#peak = this.#retained;
    this.enforce();
  }

  /** Mark `key` as used now, so it is released last. */
  touch(key: string): void {
    const owner = this.#ownerOf.get(key) ?? key;
    const entry = this.#held.get(owner);
    if (entry === undefined) return;
    this.#held.delete(owner);
    this.#held.set(owner, entry);
  }

  /** The holder dropped `key` itself; nothing is released. */
  forget(key: string): void {
    if (this.detach(key)) return;
    const entry = this.#held.get(key);
    if (entry === undefined) return;
    this.remove(key, entry);
    // What it took in is still held by its own holder, and counts again.
    for (const [member, held] of entry.members) this.restore(member, held);
    this.enforce();
  }

  /** An earlier entry holding `shares`, or one let go that can come back. */
  private takeIn(key: string, entry: Held, shares: Uint8Array): void {
    const holder = this.#holderOf.get(shares);
    const earlier = holder === undefined ? undefined : this.#held.get(holder);
    if (holder !== undefined && holder !== key && earlier !== undefined) {
      this.remove(holder, earlier);
      entry.members.set(holder, earlier);
      for (const [member, held] of earlier.members)
        entry.members.set(member, held);
      return;
    }
    const gone = this.#letGo.get(shares);
    if (gone === undefined || gone.key === key || this.has(gone.key)) return;
    this.#letGo.delete(shares);
    if (gone.held.reclaim?.() === true) entry.members.set(gone.key, gone.held);
  }

  /** Take `key` out of the entry it is a member of; whether it was one. */
  private detach(key: string): boolean {
    const owner = this.#ownerOf.get(key);
    if (owner === undefined) return false;
    this.#ownerOf.delete(key);
    this.#held.get(owner)?.members.delete(key);
    return true;
  }

  private remove(key: string, entry: Held): void {
    this.#held.delete(key);
    this.#retained -= entry.bytes;
    for (const member of entry.members.keys()) this.#ownerOf.delete(member);
    if (entry.shares !== undefined && this.#holderOf.get(entry.shares) === key)
      this.#holderOf.delete(entry.shares);
  }

  /** A member on its own again, counted at its own weight. */
  private restore(key: string, held: Held): void {
    this.#ownerOf.delete(key);
    const alone: Held = { ...held, members: new Map() };
    this.#held.set(key, alone);
    this.#retained += alone.bytes;
    if (alone.shares !== undefined) this.#holderOf.set(alone.shares, key);
  }

  private enforce(): void {
    while (this.#retained > this.maximumBytes) {
      const oldest = this.#held.entries().next();
      if (oldest.done) return;
      const [key, entry] = oldest.value;
      this.remove(key, entry);
      this.#evictions += 1;
      this.letGo(key, entry);
      for (const [member, held] of entry.members) this.letGo(member, held);
    }
  }

  private letGo(key: string, entry: Held): void {
    if (entry.shares !== undefined && entry.reclaim !== undefined)
      this.#letGo.set(entry.shares, { key, held: entry });
    entry.release();
  }
}
