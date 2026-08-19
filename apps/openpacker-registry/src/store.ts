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
import type { KeyRotation, RevocationEntry } from './keys.js';
import { holderOf, type PackageRedirect, type ProofMethod } from './holders.js';

export interface HolderNamespace {
  namespace: string;
  method: string;
  keyIds: string[];
  verifiedAt?: string;
  packageCount: number;
}

export interface HolderSummary {
  holderId: string;
  namespaces: HolderNamespace[];
}

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
  #searchable = false;

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
        title TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
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
      CREATE TABLE IF NOT EXISTS revocations (
        key_id TEXT PRIMARY KEY,
        revoked_at TEXT NOT NULL,
        effective TEXT NOT NULL,
        reason TEXT,
        detail TEXT,
        replaced_by TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS revocation_serial (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        serial INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS key_rotations (
        next_key_id TEXT PRIMARY KEY,
        previous_key_id TEXT NOT NULL,
        next_public_key TEXT NOT NULL,
        rotated_at TEXT NOT NULL,
        signature TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS namespace_keys (
        namespace TEXT NOT NULL,
        key_id TEXT NOT NULL,
        method TEXT NOT NULL,
        holder_id TEXT NOT NULL DEFAULT '',
        verified_at TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (namespace, key_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS namespace_keys_holder ON namespace_keys(holder_id);
      CREATE TABLE IF NOT EXISTS publish_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        holder_id TEXT NOT NULL,
        at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS publish_events_holder ON publish_events(holder_id, at);
      CREATE TABLE IF NOT EXISTS redirects (
        from_name TEXT PRIMARY KEY,
        to_name TEXT NOT NULL,
        effective_at TEXT NOT NULL,
        reason TEXT NOT NULL,
        previous_holder TEXT,
        next_holder TEXT,
        redirect_digest TEXT NOT NULL,
        signatures BLOB NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS status_events (
        event_id TEXT NOT NULL,
        name TEXT NOT NULL,
        version TEXT NOT NULL,
        status TEXT NOT NULL,
        issued_at INTEGER NOT NULL,
        update_digest TEXT NOT NULL,
        update_document BLOB NOT NULL,
        signatures BLOB NOT NULL,
        recorded_at TEXT NOT NULL,
        PRIMARY KEY (name, version, event_id),
        FOREIGN KEY (name, version) REFERENCES entries(name, version)
      ) STRICT;
    `);
    this.#migrateStatusEvents();
    this.#database.exec(
      'CREATE INDEX IF NOT EXISTS status_events_order ON status_events(name, version, issued_at DESC)',
    );
    // A registry that predates holder attribution has proofs with no holder.
    // Backfilling on open keeps `GET /v1/holders` honest about history rather
    // than reporting an empty world until somebody publishes again.
    this.#migrateNamespaceKeys();
    this.#searchable = this.#createSearchIndex();
  }

  /**
   * Build the search index over `entries`, or report that this build cannot.
   *
   * External-content FTS5: the index stores no copy of the text, it reads
   * `entries`. That is deliberate — a search index maintained as a second store
   * is a second store that can disagree with the first, and a registry whose
   * search and reads disagree has two answers to the same question.
   *
   * FTS5 is compiled into most SQLite builds but not required to be. When it is
   * missing the registry still works, on `LIKE`, and says which it used rather
   * than quietly serving slower answers.
   */
  #createSearchIndex(): boolean {
    try {
      this.#database.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
          name, title, description,
          content='entries', content_rowid='sequence', tokenize='unicode61'
        );
        CREATE TRIGGER IF NOT EXISTS entries_fts_insert AFTER INSERT ON entries BEGIN
          INSERT INTO entries_fts(rowid, name, title, description)
          VALUES (new.sequence, new.name, new.title, new.description);
        END;
        CREATE TRIGGER IF NOT EXISTS entries_fts_delete AFTER DELETE ON entries BEGIN
          INSERT INTO entries_fts(entries_fts, rowid, name, title, description)
          VALUES ('delete', old.sequence, old.name, old.title, old.description);
        END;
        CREATE TRIGGER IF NOT EXISTS entries_fts_update AFTER UPDATE ON entries BEGIN
          INSERT INTO entries_fts(entries_fts, rowid, name, title, description)
          VALUES ('delete', old.sequence, old.name, old.title, old.description);
          INSERT INTO entries_fts(rowid, name, title, description)
          VALUES (new.sequence, new.name, new.title, new.description);
        END;
      `);
      // Rebuild from `entries` on open: a database written by a build without
      // FTS5, or one whose triggers were added after the fact, would otherwise
      // have an index that silently omits everything published before now.
      this.#database.exec(
        `INSERT INTO entries_fts(entries_fts) VALUES ('rebuild')`,
      );
      return true;
    } catch {
      return false;
    }
  }

  #migrateStatusEvents(): void {
    const columns = this.#database
      .prepare('PRAGMA table_info(status_events)')
      .all() as unknown as { name: string; pk: number }[];
    if (
      columns.some(({ name }) => name === 'issued_at') &&
      columns.filter(({ pk }) => pk > 0).length === 3
    )
      return;
    const rows = this.#database
      .prepare('SELECT * FROM status_events')
      .all() as unknown as {
      event_id: string;
      name: string;
      version: string;
      status: string;
      update_digest: string;
      update_document: Uint8Array;
      signatures: Uint8Array;
      recorded_at: string;
    }[];
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      this.#database.exec(`
        CREATE TABLE status_events_v2 (
          event_id TEXT NOT NULL,
          name TEXT NOT NULL,
          version TEXT NOT NULL,
          status TEXT NOT NULL,
          issued_at INTEGER NOT NULL,
          update_digest TEXT NOT NULL,
          update_document BLOB NOT NULL,
          signatures BLOB NOT NULL,
          recorded_at TEXT NOT NULL,
          PRIMARY KEY (name, version, event_id),
          FOREIGN KEY (name, version) REFERENCES entries(name, version)
        ) STRICT
      `);
      const insert = this.#database.prepare(
        `INSERT INTO status_events_v2
           (event_id, name, version, status, issued_at, update_digest,
            update_document, signatures, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const row of rows) {
        const document = JSON.parse(
          new TextDecoder().decode(row.update_document),
        ) as { issuedAt?: string };
        const issuedAt = Date.parse(document.issuedAt ?? row.recorded_at);
        insert.run(
          row.event_id,
          row.name,
          row.version,
          row.status,
          Number.isFinite(issuedAt) ? issuedAt : 0,
          row.update_digest,
          row.update_document,
          row.signatures,
          row.recorded_at,
        );
      }
      this.#database.exec(
        'DROP TABLE status_events; ALTER TABLE status_events_v2 RENAME TO status_events; COMMIT',
      );
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }

  /** Whether searches use the index or fall back to a scan. */
  get searchIndexed(): boolean {
    return this.#searchable;
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
            source_id, manifest_digest, manifest, signatures, title, description)
         VALUES (?, ?, 'active', ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
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
        // Projected from the manifest, not stored beside it: manifests are
        // immutable, so these cannot come to disagree with what they summarise.
        input.manifest.title ?? '',
        input.manifest.description ?? '',
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
  list(query: ListQuery): {
    entries: StoredEntry[];
    hasMore: boolean;
    lastReadSequence?: number;
  } {
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
      // `LIKE '%x%'` cannot use an index: every search is a full scan, which is
      // the shape behind the MCP registry's 20–25 second reads. The index is
      // built from `entries` rather than maintained alongside it, so there is
      // no second copy of the corpus to drift out of step with the first.
      const match = this.#searchable ? ftsQuery(query.search) : undefined;
      if (match !== undefined) {
        where.push(
          'sequence IN (SELECT rowid FROM entries_fts WHERE entries_fts MATCH ?)',
        );
        parameters.push(match);
      } else {
        where.push('lower(name) LIKE ?');
        parameters.push(`%${query.search.toLowerCase()}%`);
      }
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
    const lastReadSequence = entries.at(-1)?.sequence;
    return {
      entries: filtered,
      hasMore: rows.length > query.limit,
      ...(lastReadSequence === undefined ? {} : { lastReadSequence }),
    };
  }

  applyStatus(input: {
    eventId: string;
    name: string;
    version: string;
    status: EntryStatus;
    updateDigest: string;
    update: JsonValue;
    signatures: readonly unknown[];
    issuedAt: number;
    now: string;
  }): StoredEntry {
    const existing = this.get(input.name, input.version);
    if (!existing)
      throw new RegistryStoreError(
        'NOT_FOUND',
        `${input.name}@${input.version} is not published here`,
      );
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      if (
        this.#database
          .prepare(
            'SELECT 1 FROM status_events WHERE name = ? AND version = ? AND event_id = ?',
          )
          .get(input.name, input.version, input.eventId)
      )
        throw new RegistryStoreError(
          'EVENT_EXISTS',
          `Lifecycle event ${input.eventId} was already applied to ${input.name}@${input.version}`,
        );
      const latest = this.#database
        .prepare(
          'SELECT MAX(issued_at) AS issued_at FROM status_events WHERE name = ? AND version = ?',
        )
        .get(input.name, input.version) as { issued_at: number | null };
      if (latest.issued_at !== null && input.issuedAt <= latest.issued_at)
        throw new RegistryStoreError(
          'EVENT_OUT_OF_ORDER',
          `Lifecycle event ${input.eventId} is not newer than the current state`,
        );
      this.#database
        .prepare(
          `INSERT INTO status_events
             (event_id, name, version, status, issued_at, update_digest,
              update_document, signatures, recorded_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.eventId,
          input.name,
          input.version,
          input.status,
          input.issuedAt,
          input.updateDigest,
          canonicalBytes(input.update),
          new TextEncoder().encode(JSON.stringify(input.signatures)),
          input.now,
        );
      this.#database
        .prepare(
          'UPDATE entries SET status = ?, updated_at = ? WHERE name = ? AND version = ?',
        )
        .run(input.status, input.now, input.name, input.version);
      this.#recomputeLatest(input.name);
      this.#database.exec('COMMIT');
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
    return this.get(input.name, input.version)!;
  }

  /** Atomically carry authority forward and retire the predecessor. */
  rotateKey(rotation: KeyRotation, revocation: RevocationEntry): boolean {
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      if (
        this.#database
          .prepare('SELECT 1 FROM revocations WHERE key_id = ?')
          .get(rotation.previousKeyId)
      ) {
        this.#database.exec('ROLLBACK');
        return false;
      }
      this.#database
        .prepare(
          `INSERT INTO key_rotations(next_key_id, previous_key_id, next_public_key, rotated_at, signature)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          rotation.nextKeyId,
          rotation.previousKeyId,
          JSON.stringify(rotation.nextPublicKey),
          rotation.rotatedAt,
          rotation.signature,
        );
      const bindings = this.#database
        .prepare(
          `SELECT namespace, method, holder_id, verified_at
         FROM namespace_keys WHERE key_id = ?`,
        )
        .all(rotation.previousKeyId) as unknown as {
        namespace: string;
        method: string;
        holder_id: string;
        verified_at: string;
      }[];
      for (const binding of bindings)
        this.#database
          .prepare(
            `INSERT OR REPLACE INTO namespace_keys
             (namespace, key_id, method, holder_id, verified_at)
           VALUES (?, ?, ?, ?, ?)`,
          )
          .run(
            binding.namespace,
            rotation.nextKeyId,
            binding.method,
            binding.holder_id,
            binding.verified_at,
          );
      this.revoke(revocation);
      this.#database.exec('COMMIT');
      return true;
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
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

  revocations(): readonly RevocationEntry[] {
    return (
      this.#database
        .prepare('SELECT * FROM revocations ORDER BY key_id')
        .all() as unknown as {
        key_id: string;
        revoked_at: string;
        effective: string;
        reason: string | null;
        detail: string | null;
        replaced_by: string | null;
      }[]
    ).map(
      (row): RevocationEntry => ({
        keyId: row.key_id,
        revokedAt: row.revoked_at,
        effective: row.effective as RevocationEntry['effective'],
        ...(row.reason === null
          ? {}
          : { reason: row.reason as RevocationEntry['reason'] }),
        ...(row.detail === null ? {} : { detail: row.detail }),
        ...(row.replaced_by === null ? {} : { replacedBy: row.replaced_by }),
      }),
    );
  }

  /**
   * Record a revocation and bump the serial.
   *
   * The serial moves on every change so a client can tell a current list from
   * a stale one — a mirror that quietly stopped updating would otherwise pin
   * its consumers to the state of the world before a compromise.
   */
  revoke(entry: RevocationEntry): number {
    this.#database
      .prepare(
        `INSERT INTO revocations(key_id, revoked_at, effective, reason, detail, replaced_by)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(key_id) DO UPDATE SET
           revoked_at = excluded.revoked_at, effective = excluded.effective,
           reason = excluded.reason, detail = excluded.detail,
           replaced_by = excluded.replaced_by`,
      )
      .run(
        entry.keyId,
        entry.revokedAt,
        entry.effective,
        entry.reason ?? null,
        entry.detail ?? null,
        entry.replacedBy ?? null,
      );
    return this.#bumpSerial();
  }

  revocationSerial(): number {
    const row = this.#database
      .prepare('SELECT serial FROM revocation_serial WHERE id = 1')
      .get() as { serial: number } | undefined;
    return row?.serial ?? 0;
  }

  #bumpSerial(): number {
    const next = this.revocationSerial() + 1;
    this.#database
      .prepare(
        'INSERT INTO revocation_serial(id, serial) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET serial = excluded.serial',
      )
      .run(next);
    return next;
  }

  rotations(): readonly KeyRotation[] {
    return (
      this.#database
        .prepare('SELECT * FROM key_rotations ORDER BY rotated_at')
        .all() as unknown as {
        next_key_id: string;
        previous_key_id: string;
        next_public_key: string;
        rotated_at: string;
        signature: string;
      }[]
    ).map((row) => ({
      nextKeyId: row.next_key_id,
      previousKeyId: row.previous_key_id,
      nextPublicKey: JSON.parse(row.next_public_key) as JsonWebKey,
      rotatedAt: row.rotated_at,
      signature: row.signature,
    }));
  }

  /** Bind a signing key to a namespace, attributed to the holder it rests on. */
  trustKey(
    namespace: string,
    keyId: string,
    method: string,
    verifiedAt = '',
  ): void {
    this.#database
      .prepare(
        `INSERT OR REPLACE INTO namespace_keys(namespace, key_id, method, holder_id, verified_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        namespace,
        keyId,
        method,
        holderOf(namespace, method as ProofMethod),
        verifiedAt,
      );
  }

  /** Key ids permitted to publish under a namespace. */
  keysFor(namespace: string): readonly string[] {
    return (
      this.#database
        .prepare('SELECT key_id FROM namespace_keys WHERE namespace = ?')
        .all(namespace) as { key_id: string }[]
    ).map((row) => row.key_id);
  }

  /** Every holder with a namespace here, most namespaces first. */
  holders(): readonly HolderSummary[] {
    const rows = this.#database
      .prepare(
        `SELECT holder_id, COUNT(DISTINCT namespace) AS n
         FROM namespace_keys WHERE holder_id != ''
         GROUP BY holder_id ORDER BY n DESC, holder_id ASC`,
      )
      .all() as { holder_id: string; n: number }[];
    return rows
      .map((row) => this.holder(row.holder_id))
      .filter((h) => h !== undefined);
  }

  /**
   * One holder's namespaces, with how many packages sit under each.
   *
   * The package count is the whole reason this route exists: 75 namespaces is a
   * different thing when they hold one package each than when they hold none.
   */
  holder(holderId: string): HolderSummary | undefined {
    const rows = this.#database
      .prepare(
        `SELECT namespace, method, key_id, verified_at
         FROM namespace_keys WHERE holder_id = ? ORDER BY namespace ASC`,
      )
      .all(holderId) as {
      namespace: string;
      method: string;
      key_id: string;
      verified_at: string;
    }[];
    if (rows.length === 0) return undefined;

    const byNamespace = new Map<string, HolderNamespace>();
    for (const row of rows) {
      const existing = byNamespace.get(row.namespace);
      if (existing) {
        existing.keyIds.push(row.key_id);
        continue;
      }
      byNamespace.set(row.namespace, {
        namespace: row.namespace,
        method: row.method,
        keyIds: [row.key_id],
        ...(row.verified_at === '' ? {} : { verifiedAt: row.verified_at }),
        packageCount: this.#packagesUnder(row.namespace),
      });
    }
    return { holderId, namespaces: [...byNamespace.values()] };
  }

  /** Which holder, if any, a namespace is attributed to. */
  holderForNamespace(namespace: string): string | undefined {
    const row = this.#database
      .prepare(
        `SELECT holder_id FROM namespace_keys WHERE namespace = ? AND holder_id != '' LIMIT 1`,
      )
      .get(namespace) as { holder_id: string } | undefined;
    return row?.holder_id;
  }

  /** Millisecond timestamps of a holder's publishes inside a window. */
  recentPublishes(holderId: string, sinceEpochMs: number): readonly number[] {
    return (
      this.#database
        .prepare(
          'SELECT at FROM publish_events WHERE holder_id = ? AND at > ? ORDER BY at ASC',
        )
        .all(holderId, sinceEpochMs) as { at: number }[]
    ).map((row) => row.at);
  }

  recordPublish(holderId: string, atEpochMs: number): void {
    this.#database
      .prepare('INSERT INTO publish_events(holder_id, at) VALUES (?, ?)')
      .run(holderId, atEpochMs);
  }

  /** Drop publish events older than the longest window anyone will ask about. */
  prunePublishEvents(beforeEpochMs: number): void {
    this.#database
      .prepare('DELETE FROM publish_events WHERE at < ?')
      .run(beforeEpochMs);
  }

  /**
   * Move every version of a name.
   *
   * The entries move rather than being copied: two live copies of a package
   * under different names would each accept publishes, and the day they
   * diverge is the day a lockfile means two different things.
   */
  rename(from: string, to: string, now: string): void {
    this.#database
      .prepare('UPDATE entries SET name = ?, updated_at = ? WHERE name = ?')
      .run(to, now, from);
    this.#database
      .prepare('UPDATE serviceability SET name = ? WHERE name = ?')
      .run(to, from);
    this.#recomputeLatest(to);
  }

  /** Record a signed move of a name. */
  recordRedirect(
    redirect: PackageRedirect,
    redirectDigest: string,
    signatures: readonly unknown[],
  ): void {
    this.#database
      .prepare(
        `INSERT OR REPLACE INTO redirects(from_name, to_name, effective_at, reason,
           previous_holder, next_holder, redirect_digest, signatures)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        redirect.from,
        redirect.to,
        redirect.effectiveAt,
        redirect.reason,
        redirect.previousHolder ?? null,
        redirect.nextHolder ?? null,
        redirectDigest,
        canonicalBytes(signatures as unknown as JsonValue),
      );
  }

  redirect(
    from: string,
  ):
    | { redirect: PackageRedirect; digest: string; signatures: unknown[] }
    | undefined {
    const row = this.#database
      .prepare('SELECT * FROM redirects WHERE from_name = ?')
      .get(from) as RedirectRow | undefined;
    return row ? toRedirect(row) : undefined;
  }

  /** Every redirect, for chain resolution. */
  redirects(): ReadonlyMap<string, PackageRedirect> {
    const rows = this.#database
      .prepare('SELECT * FROM redirects')
      .all() as unknown as RedirectRow[];
    return new Map(
      rows.map((row) => [row.from_name, toRedirect(row).redirect]),
    );
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
  /** Packages (not versions) whose name sits under a namespace. */
  #packagesUnder(namespace: string): number {
    const row = this.#database
      .prepare(
        `SELECT COUNT(DISTINCT name) AS n FROM entries
         WHERE name = ? OR name LIKE ? ESCAPE '\\'`,
      )
      .get(namespace, `${escapeLike(namespace)}.%`) as { n: number };
    return row.n;
  }

  /** Give pre-holder rows a holder, so history is not silently invisible. */
  #migrateNamespaceKeys(): void {
    const rows = this.#database
      .prepare(
        `SELECT namespace, key_id, method FROM namespace_keys WHERE holder_id = ''`,
      )
      .all() as { namespace: string; key_id: string; method: string }[];
    for (const row of rows)
      this.#database
        .prepare(
          'UPDATE namespace_keys SET holder_id = ? WHERE namespace = ? AND key_id = ?',
        )
        .run(
          holderOf(row.namespace, row.method as ProofMethod),
          row.namespace,
          row.key_id,
        );
  }

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

interface RedirectRow {
  from_name: string;
  to_name: string;
  effective_at: string;
  reason: string;
  previous_holder: string | null;
  next_holder: string | null;
  redirect_digest: string;
  signatures: Uint8Array;
}

function toRedirect(row: RedirectRow): {
  redirect: PackageRedirect;
  digest: string;
  signatures: unknown[];
} {
  return {
    redirect: {
      redirectVersion: '1',
      from: row.from_name,
      to: row.to_name,
      effectiveAt: row.effective_at,
      reason: row.reason as 'rename' | 'transfer',
      ...(row.previous_holder === null
        ? {}
        : { previousHolder: row.previous_holder }),
      ...(row.next_holder === null ? {} : { nextHolder: row.next_holder }),
    },
    digest: row.redirect_digest,
    signatures: JSON.parse(
      new TextDecoder().decode(row.signatures),
    ) as unknown[],
  };
}

/**
 * Turn a user's words into an FTS5 query, or `undefined` if nothing is left.
 *
 * Every term is quoted and a prefix match appended, because FTS5's query
 * language is a language: an unescaped `NOT`, `*` or `"` from a search box is
 * either a syntax error or a query the user did not write. Quoting turns the
 * whole thing back into terms.
 *
 * Package names are dotted, and `unicode61` splits on the dots, so searching
 * `example` finds `com.example.tool` — which is what someone typing a word into
 * a search box meant.
 */
function ftsQuery(search: string): string | undefined {
  const terms = search
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((term) => term.length > 0)
    .map((term) => `"${term}"*`);
  return terms.length > 0 ? terms.join(' AND ') : undefined;
}

/** A namespace is dotted, and `_` is a LIKE wildcard. Escape before matching. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/gu, (character) => `\\${character}`);
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
