# Storage, snapshots, cache, and deployment

## SQLite state

The reference daemon's `SqliteStateStore` uses WAL mode, foreign keys, and
strict tables. One database stores immutable canonical receipt/snapshot bytes,
the event outbox, and idempotent response bytes. Receipt and snapshot rows are
keyed by kind, digest algorithm, and digest; inserting different bytes at an
existing digest fails. Event IDs are unique and sequence numbers are replay
checkpoints. Reusing an idempotency key for different result bytes fails.

SQLite row IDs and event sequences are operational indexes, not PREX identity.
Set an explicit daemon `databasePath` for persistent operation; the class
defaults to `:memory:` when embedded directly. Readiness currently means the
store is open.

## Catalog snapshots are the cache boundary

Providers acquire and normalize records before solve. `CatalogSnapshotBuilder`
sorts record keys, hashes raw record bytes or canonical metadata, hashes the
record index, and emits a `SourceSnapshot` containing provider identity,
endpoint identity, retrieval/evaluation times, revision/ETag, and root/records
digests. `InMemoryCatalogStore` imports only verified canonical bundles.

There is no implicit live-provider cache inside the resolver. A validated
immutable snapshot is the reusable cache unit: pin its root digest, replay it
offline, and invalidate it by selecting a different snapshot. Do not mutate a
snapshot in place or treat an ETag alone as byte identity.

## Filesystem CAS

`FilesystemArtifactStore` lays out immutable blobs at `blobs/sha256/<digest>`,
referrer descriptors under the subject digest, and same-filesystem temporary
uploads under `tmp`. It streams reads/writes, supports ranges, checks expected
size/digest, makes duplicate puts idempotent only for matching content, and
removes partial uploads after cancellation or failure. Place the CAS and
temporary directory on the same filesystem to retain link-based atomic
publication.

Protect the CAS root from untrusted writes. It contains public or private
package bytes according to provider policy; filesystem permissions and volume
encryption are deployment concerns. Credentials never belong in the CAS.

## OCI layout and registry

`OciImageLayout` writes `oci-layout`, `index.json`, and digest-addressed blobs.
It is the portable, registry-free default and should live on a filesystem with
atomic rename/link behavior. `OciRegistryClient` is configured with an origin
URL, lowercase repository, standard `fetch`, and an authentication callback. The
URL must not contain credentials, query, or fragment. Cross-origin upload
redirects are rejected so authorization is not leaked.

Registry tags and locations are mutable. Persist the OCI manifest and blob
digests in receipts/lockfiles and rediscover locations through policy-approved
sources. Optional live compatibility runs with `npm run test:live` and requires
the digest-pinned tool images configured by `.github/workflows/live-compat.yml`;
mandatory tests and demo use local fixtures/layouts.

## Deployment shape

For a single-node reference service, colocate the SQLite database and CAS on
durable volumes and run the daemon as a non-root user. Keep provider credentials
in a credential resolver or token file readable only by that user. Put TLS and
client authentication at the service boundary when not loopback. Set request,
timeout, catalog, graph, and materialization limits from discovered/compiled
bounds rather than accepting provider defaults.

Horizontal service replicas require an externally coordinated state-store
implementation; sharing a local SQLite file or filesystem CAS over an arbitrary
network filesystem is not documented as safe. PREX interfaces permit another
repository implementation without changing protocol objects.
