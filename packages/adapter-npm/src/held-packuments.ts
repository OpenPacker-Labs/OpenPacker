import { formatDigest, safeEcho, sha256 } from '@openpacker/canonical';
import {
  ProviderError,
  type HttpTransport,
  type ProviderRecord,
  type RetentionLedger,
} from '@openpacker/adapter-core';
import type { NpmPackument } from './index.js';
import { NPM_NAME_LIMIT } from './packument-limits.js';

/** The packument's objects, the text they came from, and where from. */
export type PackumentRecord = ProviderRecord<NpmPackument>;

/**
 * A packument this provider has read. `record` holds its objects until the
 * resolve's budget lets them go; what the snapshot needs to say the document
 * was read, its digest and etag and when, is kept for good.
 */
export interface HeldPackument {
  readonly key: string;
  /** Of the text, once it has been let go; until then the record has it. */
  readonly digest?: Promise<string>;
  readonly etag?: string;
  readonly retrievedAt: string;
  readonly record: PackumentRecord | undefined;
}

async function digestOf(bytes: Uint8Array): Promise<string> {
  return formatDigest(await sha256(bytes));
}

/**
 * The packuments a provider has read, and what of them it keeps.
 *
 * Where its transport lets a holder let go of what it can get again, the
 * provider says what it keeps to the transport's ledger (`retention`), and a
 * packument let go is read again through the transport. Only a transport that
 * says it can be asked again (`refetchable`) is trusted to answer.
 */
export class HeldPackuments {
  readonly #held = new Map<string, HeldPackument>();
  /** Packuments being read for the first time, or again, which a second asker waits for. */
  readonly #reading = new Map<string, Promise<PackumentRecord>>();

  constructor(
    private readonly transport: HttpTransport,
    private readonly endpoint: string,
  ) {}

  private get ledger(): RetentionLedger | undefined {
    return this.transport.refetchable === true
      ? this.transport.retention
      : undefined;
  }

  private ledgerKey(key: string): string {
    return `npm\n${this.endpoint}\n${key}`;
  }

  /** The objects of `key`, while they are held. */
  record(key: string): PackumentRecord | undefined {
    return this.#held.get(key)?.record;
  }

  values(): IterableIterator<HeldPackument> {
    return this.#held.values();
  }

  /** What the snapshot names each document read by, in key order of `held`. */
  digest(held: HeldPackument): Promise<string> {
    return held.digest ?? digestOf(held.record!.rawBody);
  }

  /**
   * `read()`, once however many ask while it runs, for a packument with no
   * objects held: each asker parsing its own would hold a tree apiece, and what
   * was let go to save memory would be read into memory several times over.
   */
  once(
    key: string,
    read: () => Promise<PackumentRecord>,
  ): Promise<PackumentRecord> {
    if (this.record(key) !== undefined) return read();
    const reading = this.#reading.get(key);
    if (reading !== undefined) return reading;
    const started = read().finally(() => {
      this.#reading.delete(key);
    });
    this.#reading.set(key, started);
    return started;
  }

  /** `existing`, which the origin says is current. */
  revalidated(existing: PackumentRecord, retrievedAt: string): PackumentRecord {
    const kept = this.#held.get(existing.key)!;
    const record = { ...existing, retrievedAt };
    this.#held.set(existing.key, { ...kept, retrievedAt, record });
    this.ledger?.touch(this.ledgerKey(existing.key));
    return record;
  }

  /**
   * A packument read: the one that was let go, if one was, and kept now at
   * `retained`, what the parse measured its tree to keep.
   */
  async admit(
    name: string,
    record: PackumentRecord,
    retained: number,
  ): Promise<PackumentRecord> {
    const { key } = record;
    const kept = this.#held.get(key);
    // A packument read again after it was let go must be the one that was: a
    // resolve that took two different documents under one name would record
    // evidence for neither.
    if (
      kept?.record === undefined &&
      kept?.digest !== undefined &&
      (await kept.digest) !== (await digestOf(record.rawBody))
    )
      throw new ProviderError(
        'STALE_METADATA',
        `The packument of ${safeEcho(name, NPM_NAME_LIMIT)} changed while the resolve was running; run it again`,
      );
    this.#held.set(key, {
      key,
      retrievedAt: record.retrievedAt,
      ...(!(record.etag === undefined) && { etag: record.etag }),
      record,
    });
    // What this record keeps alive by itself: the objects (what the parse
    // measured the tree to keep), and the text they came from, which the
    // transport may be holding as well.
    this.ledger?.retain(
      this.ledgerKey(key),
      retained + record.rawBody.byteLength,
      () => this.letGo(key),
    );
    return record;
  }

  invalidate(key?: string): void {
    for (const each of key === undefined ? [...this.#held.keys()] : [key]) {
      this.ledger?.forget(this.ledgerKey(each));
      this.#held.delete(each);
    }
  }

  /**
   * The objects of a packument go; that it was read, and what it said, stay.
   * The digest of its text is taken as it goes, because the text goes with it:
   * it is what the snapshot says was read, and what a second reading is
   * compared with.
   */
  private letGo(key: string): void {
    const kept = this.#held.get(key);
    if (kept?.record === undefined) return;
    const digest = digestOf(kept.record.rawBody);
    // Not awaited here: a refusal is the asker's, when it is awaited.
    digest.catch(() => undefined);
    this.#held.set(key, { ...kept, digest, record: undefined });
  }
}
