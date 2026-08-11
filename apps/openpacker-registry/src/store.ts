/**
 * Storage for a PREX registry.
 *
 * Two properties drive the schema. Published manifests are immutable, so a
 * re-publish of an existing `(name, version)` with different bytes is a
 * conflict rather than an update — a lockfile means nothing otherwise. And a
 * mirror must be able to replay every change exactly once, so ordering is by a
 * monotonic sequence the registry assigns, never by a wall clock: two writes in
 * the same millisecond, or a clock that steps back, would otherwise let a page
 * boundary drop a record nobody asks for again.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { canonicalBytes } from '@openpacker/canonical';
import type { JsonValue, PackageManifest } from '@openpacker/contracts';
import type { ServiceabilityRecord } from './serviceability.js';

export type EntryStatus = 'active' | 'deprecated' | 'deleted';

export interface StoredEntry {
  /** Monotonic, registry-assigned. The sync order and the cursor's basis. */
  sequence: number;
  name: string;
  version: string;
  status: EntryStatus;
  publishedAt: string;
  updatedAt: string;
  isLatest: boolean;
  sourceId?: string;
  manifestDigest: string;
  manifest: PackageManifest;
  signatures: readonly unknown[];
}

export interface ListQuery {
  search?: string;
  purlType?: string;
  /** Sequence to resume after — the decoded cursor. */
  afterSequence?: number;
  /** RFC 3339; entries updated strictly after this. */
  updatedSince?: string;
  limit: number;
  /** Include entries withdrawn from listings. */
  includeDeleted?: boolean;
}

export class RegistryStore {
  readonly #database: DatabaseSync;
  #closed = false;

  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.#database = new DatabaseSync(path);
    this.#database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS entries (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        version TEXT NOT NULL,
        status TEXT NOT NULL,
        published_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        is_latest INTEGER NOT NULL,
        source_id TEXT,
        manifest_digest TEXT NOT NULL,
        manifest BLOB NOT NULL,
        signatures BLOB NOT NULL,
        UNIQUE (name, version)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS entries_updated ON entries(updated_at, sequence);
      CREATE INDEX IF NOT EXISTS entries_name ON entries(name);
      CREATE TABLE IF NOT EXISTS serviceability (
        name TEXT NOT NULL,
        version TEXT NOT NULL,
        state TEXT NOT NULL,
        checked_at TEXT NOT NULL,
        method TEXT NOT NULL,
        detail TEXT,
        PRIMARY KEY (name, version)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS namespace_keys (
        namespace TEXT NOT NULL,
        key_id TEXT NOT NULL,
        method TEXT NOT NULL,
        PRIMARY KEY (namespace, key_id)
      ) STRICT;
    `);
  }

  ready(): boolean {
    return !this.#closed;
  }

  /**
   * Store a manifest, or return the existing entry when the bytes match.
   *
   * A matching re-publish is idempotent — a retried request must not be a
   * conflict. A differing one is refused: republishing `1.2.3` with new
   * contents is how a pinned build changes underneath someone.
   */
  publish(input: {
    manifest: PackageManifest;
    manifestDigest: string;
    signatures: readonly unknown[];
    now: string;
    sourceId?: string;
  }): { entry: StoredEntry; created: boolean } {
    const existing = this.get(input.manifest.name, input.manifest.version);
    if (existing) {
      if (existing.manifestDigest !== input.manifestDigest)
        throw new RegistryStoreError(
          'VERSION_EXISTS',
          `${input.manifest.name}@${input.manifest.version} is already published ` +
            `as ${existing.manifestDigest}; a version's contents never change.`,
        );
      return { entry: existing, created: false };
    }

    this.#database
      .prepare(
        `INSERT INTO entries
           (name, version, status, published_at, updated_at, is_latest,
            source_id, manifest_digest, manifest, signatures)
         VALUES (?, ?, 'active', ?, ?, 0, ?, ?, ?, ?)`,
      )
      .run(
        input.manifest.name,
        input.manifest.version,
        input.now,
        input.now,
        input.sourceId ?? null,
        input.manifestDigest,
        canonicalBytes(input.manifest as unknown as JsonValue),
        new TextEncoder().encode(JSON.stringify(input.signatures)),
      );
    this.#recomputeLatest(input.manifest.name);
    const entry = this.get(input.manifest.name, input.manifest.version)!;
    return { entry, created: true };
  }

  get(name: string, version: string): StoredEntry | undefined {
    if (version === 'latest') {
      const row = this.#database
        .prepare(
          'SELECT * FROM entries WHERE name = ? AND is_latest = 1 LIMIT 1',
        )
        .get(name) as Row | undefined;
      return row ? toEntry(row) : undefined;
    }
    const row = this.#database
      .prepare('SELECT * FROM entries WHERE name = ? AND version = ?')
      .get(name, version) as Row | undefined;
    return row ? toEntry(row) : undefined;
  }

  versions(name: string): readonly StoredEntry[] {
    const rows = this.#database
      .prepare('SELECT * FROM entries WHERE name = ? ORDER BY sequence')
      .all(name) as unknown as Row[];
    return rows.map(toEntry);
  }

  /**
   * A page of entries, ordered by the registry's own sequence.
   *
   * `limit + 1` rows are read so the caller can tell "there is more" from
   * "exactly a page remained" without a second query or a count.
   */
  list(query: ListQuery): { entries: StoredEntry[]; hasMore: boolean } {
    const where: string[] = [];
    const parameters: (string | number)[] = [];
    if (!query.includeDeleted) where.push("status != 'deleted'");
    if (query.afterSequence !== undefined) {
      where.push('sequence > ?');
      parameters.push(query.afterSequence);
    }
    if (query.updatedSince !== undefined) {
      where.push('updated_at > ?');
      parameters.push(query.updatedSince);
    }
    if (query.search !== undefined && query.search !== '') {
      where.push('lower(name) LIKE ?');
      parameters.push(`%${query.search.toLowerCase()}%`);
    }
    const rows = this.#database
      .prepare(
        `SELECT * FROM entries
         ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY sequence LIMIT ?`,
      )
      .all(...parameters, query.limit + 1) as unknown as Row[];

    const entries = rows.slice(0, query.limit).map(toEntry);
    const filtered =
      query.purlType === undefined
        ? entries
        : entries.filter((entry) =>
            entry.manifest.distributions.some(
              (distribution) =>
                distribution.purlType.toLowerCase() ===
                query.purlType!.toLowerCase(),
            ),
          );
    return { entries: filtered, hasMore: rows.length > query.limit };
  }

  setStatus(
    name: string,
    version: string,
    status: EntryStatus,
    now: string,
  ): StoredEntry {
    const existing = this.get(name, version);
    if (!existing)
      throw new RegistryStoreError(
        'NOT_FOUND',
        `${name}@${version} is not published here`,
      );
    this.#database
      .prepare(
        'UPDATE entries SET status = ?, updated_at = ? WHERE name = ? AND version = ?',
      )
      .run(status, now, name, version);
    this.#recomputeLatest(name);
    return this.get(name, version)!;
  }

  serviceability(
    name: string,
    version: string,
  ): ServiceabilityRecord | undefined {
    const row = this.#database
      .prepare(
        'SELECT state, checked_at, method, detail FROM serviceability WHERE name = ? AND version = ?',
      )
      .get(name, version) as
      | {
          state: string;
          checked_at: string;
          method: string;
          detail: string | null;
        }
      | undefined;
    if (!row) return undefined;
    return {
      state: row.state as ServiceabilityRecord['state'],
      checkedAt: row.checked_at,
      method: row.method as ServiceabilityRecord['method'],
      ...(row.detail === null ? {} : { detail: row.detail }),
    };
  }

  recordServiceability(
    name: string,
    version: string,
    record: ServiceabilityRecord,
  ): void {
    this.#database
      .prepare(
        `INSERT INTO serviceability(name, version, state, checked_at, method, detail)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(name, version) DO UPDATE SET
           state = excluded.state, checked_at = excluded.checked_at,
           method = excluded.method, detail = excluded.detail`,
      )
      .run(
        name,
        version,
        record.state,
        record.checkedAt,
        record.method,
        record.detail ?? null,
      );
  }

  /**
   * Mark a record for re-check on the next read.
   *
   * How a client-reported observation is honoured: it moves the check earlier,
   * and nothing more. A report can never set state, or "report a competitor
   * unreachable" becomes a feature of the registry.
   */
  expireServiceability(name: string, version: string): void {
    this.#database
      .prepare(
        "UPDATE serviceability SET checked_at = '1970-01-01T00:00:00.000Z' WHERE name = ? AND version = ?",
      )
      .run(name, version);
  }

  /** Bind a signing key to a namespace, as an operator decision. */
  trustKey(namespace: string, keyId: string, method: string): void {
    this.#database
      .prepare(
        'INSERT OR REPLACE INTO namespace_keys(namespace, key_id, method) VALUES (?, ?, ?)',
      )
      .run(namespace, keyId, method);
  }

  /** Key ids permitted to publish under a namespace. */
  keysFor(namespace: string): readonly string[] {
    return (
      this.#database
        .prepare('SELECT key_id FROM namespace_keys WHERE namespace = ?')
        .all(namespace) as { key_id: string }[]
    ).map((row) => row.key_id);
  }

  close(): void {
    if (!this.#closed) this.#database.close();
    this.#closed = true;
  }

  /**
   * Recompute which version of a name is latest.
   *
   * Highest published sequence among non-deleted versions. Deliberately not a
   * version comparison: this registry serves many ecosystems and does not own
   * every one's ordering rules, and guessing them would make `latest` mean
   * something different depending on the package.
   */
  #recomputeLatest(name: string): void {
    this.#database
      .prepare('UPDATE entries SET is_latest = 0 WHERE name = ?')
      .run(name);
    this.#database
      .prepare(
        `UPDATE entries SET is_latest = 1
         WHERE sequence = (
           SELECT sequence FROM entries
           WHERE name = ? AND status != 'deleted'
           ORDER BY sequence DESC LIMIT 1
         )`,
      )
      .run(name);
  }
}

export class RegistryStoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'RegistryStoreError';
    this.code = code;
  }
}

interface Row {
  sequence: number;
  name: string;
  version: string;
  status: string;
  published_at: string;
  updated_at: string;
  is_latest: number;
  source_id: string | null;
  manifest_digest: string;
  manifest: Uint8Array;
  signatures: Uint8Array;
}

function toEntry(row: Row): StoredEntry {
  const decoder = new TextDecoder();
  return {
    sequence: row.sequence,
    name: row.name,
    version: row.version,
    status: row.status as EntryStatus,
    publishedAt: row.published_at,
    updatedAt: row.updated_at,
    isLatest: row.is_latest === 1,
    ...(row.source_id === null ? {} : { sourceId: row.source_id }),
    manifestDigest: row.manifest_digest,
    manifest: JSON.parse(
      decoder.decode(row.manifest),
    ) as unknown as PackageManifest,
    signatures: JSON.parse(decoder.decode(row.signatures)) as unknown[],
  };
}
