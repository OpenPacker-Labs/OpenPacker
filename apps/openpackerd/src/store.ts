import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  canonicalBytes,
  canonicalDigest,
  formatDigest,
} from '@openpacker/canonical';
import type {
  JsonValue,
  OpenPackerCloudEvent,
  ResolutionReceipt,
  SignedReceipt,
  SourceSnapshot,
} from '@openpacker/contracts';

export interface StoredEvent {
  cursor: number;
  event: OpenPackerCloudEvent;
  bytes: Uint8Array;
}

export interface OpenPackerStateStore {
  ready(): boolean;
  putReceipt(receipt: SignedReceipt | ResolutionReceipt): Promise<string>;
  getReceipt(algorithm: string, digest: string): Uint8Array | undefined;
  putSnapshot(snapshot: SourceSnapshot | JsonValue): Promise<string>;
  getSnapshot(algorithm: string, digest: string): Uint8Array | undefined;
  appendEvent(event: OpenPackerCloudEvent): number;
  eventsAfter(cursor: number, limit: number): StoredEvent[];
  getIdempotent(
    method: string,
    path: string,
    key: string,
  ): Uint8Array | undefined;
  putIdempotent(
    method: string,
    path: string,
    key: string,
    bytes: Uint8Array,
  ): void;
  close(): void;
}

export class SqliteStateStore implements OpenPackerStateStore {
  readonly #database: DatabaseSync;
  #closed = false;

  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.#database = new DatabaseSync(path);
    this.#database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS objects (
        kind TEXT NOT NULL,
        algorithm TEXT NOT NULL,
        digest TEXT NOT NULL,
        bytes BLOB NOT NULL,
        PRIMARY KEY (kind, algorithm, digest)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS event_outbox (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        bytes BLOB NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS idempotency (
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        key TEXT NOT NULL,
        bytes BLOB NOT NULL,
        PRIMARY KEY (method, path, key)
      ) STRICT;
    `);
  }

  ready(): boolean {
    return !this.#closed;
  }

  async putReceipt(
    receipt: SignedReceipt | ResolutionReceipt,
  ): Promise<string> {
    const digest =
      'receiptDigest' in receipt
        ? receipt.receiptDigest
        : await canonicalDigest(receipt as unknown as JsonValue);
    return this.#put(
      'receipt',
      digest.algorithm,
      digest.value,
      canonicalBytes(receipt as unknown as JsonValue),
    );
  }

  getReceipt(algorithm: string, digest: string): Uint8Array | undefined {
    return this.#get('receipt', algorithm, digest);
  }

  async putSnapshot(snapshot: SourceSnapshot | JsonValue): Promise<string> {
    const source = snapshot as SourceSnapshot;
    const digest =
      source.rootDigest?.algorithm === 'sha256'
        ? source.rootDigest
        : await canonicalDigest(snapshot as JsonValue);
    return this.#put(
      'snapshot',
      digest.algorithm,
      digest.value,
      canonicalBytes(snapshot as JsonValue),
    );
  }

  getSnapshot(algorithm: string, digest: string): Uint8Array | undefined {
    return this.#get('snapshot', algorithm, digest);
  }

  appendEvent(event: OpenPackerCloudEvent): number {
    const bytes = canonicalBytes(event as unknown as JsonValue);
    this.#database
      .prepare(
        'INSERT OR IGNORE INTO event_outbox(event_id, bytes) VALUES (?, ?)',
      )
      .run(event.id, bytes);
    const row = this.#database
      .prepare('SELECT sequence FROM event_outbox WHERE event_id = ?')
      .get(event.id) as { sequence: number } | undefined;
    if (!row) throw new Error(`Failed to persist event ${event.id}`);
    return row.sequence;
  }

  eventsAfter(cursor: number, limit: number): StoredEvent[] {
    const rows = this.#database
      .prepare(
        'SELECT sequence, bytes FROM event_outbox WHERE sequence > ? ORDER BY sequence LIMIT ?',
      )
      .all(cursor, limit) as Array<{ sequence: number; bytes: Uint8Array }>;
    return rows.map(({ sequence, bytes }) => ({
      cursor: sequence,
      bytes: Uint8Array.from(bytes),
      event: JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      ) as OpenPackerCloudEvent,
    }));
  }

  getIdempotent(
    method: string,
    path: string,
    key: string,
  ): Uint8Array | undefined {
    const row = this.#database
      .prepare(
        'SELECT bytes FROM idempotency WHERE method = ? AND path = ? AND key = ?',
      )
      .get(method, path, key) as { bytes: Uint8Array } | undefined;
    return row ? Uint8Array.from(row.bytes) : undefined;
  }

  putIdempotent(
    method: string,
    path: string,
    key: string,
    bytes: Uint8Array,
  ): void {
    this.#database
      .prepare(
        'INSERT OR IGNORE INTO idempotency(method, path, key, bytes) VALUES (?, ?, ?, ?)',
      )
      .run(method, path, key, bytes);
    const existing = this.getIdempotent(method, path, key);
    if (!existing || !equalBytes(existing, bytes))
      throw new Error('Idempotency key was reused for a different result');
  }

  close(): void {
    if (!this.#closed) this.#database.close();
    this.#closed = true;
  }

  #put(
    kind: string,
    algorithm: string,
    digest: string,
    bytes: Uint8Array,
  ): string {
    validateDigest(algorithm, digest);
    this.#database
      .prepare(
        'INSERT OR IGNORE INTO objects(kind, algorithm, digest, bytes) VALUES (?, ?, ?, ?)',
      )
      .run(kind, algorithm, digest, bytes);
    const existing = this.#get(kind, algorithm, digest);
    if (!existing || !equalBytes(existing, bytes))
      throw new Error(
        `Immutable ${kind} digest collision: ${algorithm}:${digest}`,
      );
    return `${algorithm}:${digest}`;
  }

  #get(
    kind: string,
    algorithm: string,
    digest: string,
  ): Uint8Array | undefined {
    validateDigest(algorithm, digest);
    const row = this.#database
      .prepare(
        'SELECT bytes FROM objects WHERE kind = ? AND algorithm = ? AND digest = ?',
      )
      .get(kind, algorithm, digest) as { bytes: Uint8Array } | undefined;
    return row ? Uint8Array.from(row.bytes) : undefined;
  }
}

function validateDigest(algorithm: string, digest: string): void {
  if (algorithm !== 'sha256' || !/^[0-9a-f]{64}$/u.test(digest))
    throw new TypeError(`Invalid digest: ${algorithm}:${digest}`);
  formatDigest({ algorithm, value: digest });
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength &&
    left.every((byte, index) => byte === right[index])
  );
}
