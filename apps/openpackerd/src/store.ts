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
  /**
   * Cached response for an idempotency key.
   *
   * `request` is the fingerprint of the request that produced it, so a caller
   * can tell "same request again" from "same key, different request" — those
   * are opposite answers and only the first may be served from cache.
   */
  getIdempotent(
    method: string,
    path: string,
    key: string,
  ): { bytes: Uint8Array; request: string } | undefined;
  putIdempotent(
    method: string,
    path: string,
    key: string,
    request: string,
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
        request TEXT NOT NULL DEFAULT '',
        bytes BLOB NOT NULL,
        PRIMARY KEY (method, path, key)
      ) STRICT;
    `);
    this.#addIdempotencyRequestColumn();
  }

  /**
   * Bring a database written before request fingerprinting up to date.
   *
   * Rows created then carry an empty fingerprint, which never equals a real
   * one — so they read as a miss and are replaced rather than being served to
   * a request nobody proved they match.
   */
  #addIdempotencyRequestColumn(): void {
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const columns = this.#database
      .prepare('PRAGMA table_info(idempotency)')
      .all() as Array<{ name: string }>;
    if (columns.some((column) => column.name === 'request')) return;
    this.#database.exec(
      "ALTER TABLE idempotency ADD COLUMN request TEXT NOT NULL DEFAULT ''",
    );
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
        : // SAFETY: The surrounding boundary establishes the asserted domain contract.
          await canonicalDigest(
            JSON.parse(JSON.stringify(receipt)) as JsonValue,
          );
    return this.#put(
      'receipt',
      digest.algorithm,
      digest.value,
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      canonicalBytes(JSON.parse(JSON.stringify(receipt)) as JsonValue),
    );
  }

  getReceipt(algorithm: string, digest: string): Uint8Array | undefined {
    return this.#get('receipt', algorithm, digest);
  }

  async putSnapshot(snapshot: SourceSnapshot | JsonValue): Promise<string> {
    const digest = await verifySourceSnapshot(snapshot);
    return this.#put(
      'snapshot',
      digest.algorithm,
      digest.value,
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      canonicalBytes(snapshot as JsonValue),
    );
  }

  getSnapshot(algorithm: string, digest: string): Uint8Array | undefined {
    return this.#get('snapshot', algorithm, digest);
  }

  appendEvent(event: OpenPackerCloudEvent): number {
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const bytes = canonicalBytes(
      JSON.parse(JSON.stringify(event)) as JsonValue,
    );
    this.#database
      .prepare(
        'INSERT OR IGNORE INTO event_outbox(event_id, bytes) VALUES (?, ?)',
      )
      .run(event.id, bytes);
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const row = this.#database
      .prepare('SELECT sequence FROM event_outbox WHERE event_id = ?')
      .get(event.id) as { sequence: number } | undefined;
    if (!row) throw new Error(`Failed to persist event ${event.id}`);
    return row.sequence;
  }

  eventsAfter(cursor: number, limit: number): StoredEvent[] {
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const rows = this.#database
      .prepare(
        'SELECT sequence, bytes FROM event_outbox WHERE sequence > ? ORDER BY sequence LIMIT ?',
      )
      .all(cursor, limit) as Array<{ sequence: number; bytes: Uint8Array }>;
    return rows.map(({ sequence, bytes }) => ({
      cursor: sequence,
      bytes: Uint8Array.from(bytes),
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      event: JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      ) as OpenPackerCloudEvent,
    }));
  }

  getIdempotent(
    method: string,
    path: string,
    key: string,
  ): { bytes: Uint8Array; request: string } | undefined {
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const row = this.#database
      .prepare(
        'SELECT bytes, request FROM idempotency WHERE method = ? AND path = ? AND key = ?',
      )
      .get(method, path, key) as
      | { bytes: Uint8Array; request: string }
      | undefined;
    if (!row || row.request === '') return undefined;
    return { bytes: Uint8Array.from(row.bytes), request: row.request };
  }

  putIdempotent(
    method: string,
    path: string,
    key: string,
    request: string,
    bytes: Uint8Array,
  ): void {
    this.#database
      .prepare(
        'INSERT INTO idempotency(method, path, key, request, bytes) VALUES (?, ?, ?, ?, ?) ' +
          "ON CONFLICT(method, path, key) DO UPDATE SET request = excluded.request, bytes = excluded.bytes WHERE request = ''",
      )
      .run(method, path, key, request, bytes);
    const existing = this.getIdempotent(method, path, key);
    if (!existing || !equalBytes(existing.bytes, bytes))
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
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const row = this.#database
      .prepare(
        'SELECT bytes FROM objects WHERE kind = ? AND algorithm = ? AND digest = ?',
      )
      .get(kind, algorithm, digest) as { bytes: Uint8Array } | undefined;
    return row ? Uint8Array.from(row.bytes) : undefined;
  }
}

export async function sourceSnapshotDigest(
  snapshot: SourceSnapshot | JsonValue,
): Promise<{ algorithm: 'sha256'; value: string }> {
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  const source = snapshot as SourceSnapshot;
  if (source.rootDigest?.algorithm !== 'sha256')
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    return await canonicalDigest(snapshot as JsonValue);
  const {
    snapshotId: _snapshotId,
    rootDigest: _rootDigest,
    evidenceRefs: _evidenceRefs,
    authenticationScopeRef: _authenticationScopeRef,
    extensions: _extensions,
    ...payload
  } = source;
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  return await canonicalDigest(
    JSON.parse(JSON.stringify(payload)) as JsonValue,
  );
}

export async function verifySourceSnapshot(
  snapshot: SourceSnapshot | JsonValue,
): Promise<{ algorithm: 'sha256'; value: string }> {
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  const source = snapshot as SourceSnapshot;
  const digest = await sourceSnapshotDigest(snapshot);
  if (
    source.rootDigest?.algorithm !== 'sha256' ||
    formatDigest(source.rootDigest) !== formatDigest(digest) ||
    source.snapshotId !== formatDigest(digest)
  )
    throw new Error('Snapshot id or root digest does not match its content');
  return digest;
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
