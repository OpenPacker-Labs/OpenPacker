# Backup, restore, air-gap transfer, and recovery

## Consistent backup set

A recoverable OpenPacker node consists of the SQLite database, filesystem CAS,
OCI image layouts, provider/catalog snapshot bundles, configured policy and
trusted roots/public keys, plus configuration that references (but does not
embed) secrets. Back up receipt/event bytes and artifacts together when an
operational checkpoint must be replayable.

For the reference single-node deployment:

1. stop accepting writes and gracefully stop the daemon;
2. copy the closed SQLite database as one file (WAL contents are checkpointed on
   clean close);
3. copy the CAS `blobs` and `referrers` trees and each complete OCI layout;
4. copy canonical snapshot bundles, policy, and public trust material;
5. build a manifest of path, byte length, and SHA-256 for every copied file; and
6. store secret backups separately under the organization's secret-recovery
   process.

Before stopping the service, record the database path, CAS root, OCI layout
roots, current event cursor, protocol/provider versions, known receipt and
snapshot digests, policy digest, lifecycle root, and evaluation time. The backup
manifest itself must be immutable and include a format version; a list of
filenames without lengths and digests is not a recovery record.

Do not copy only a live SQLite main file while omitting its WAL, and do not
declare success from file presence alone. An online backup implementation may
use SQLite's documented backup API, but the shipped reference runbook uses a
clean stop to keep the procedure auditable.

## Restore verification

Restore into a new empty managed root with the daemon stopped. Verify the backup
manifest first, then restore SQLite, CAS, layouts, snapshots, policy, and public
trust roots. Start on loopback and require `/v1/ready` success. Retrieve known
receipts/snapshots by digest, replay events from a recorded checkpoint, read and
digest-check representative CAS/OCI blobs, validate snapshot roots, and run
receipt verification against the restored policy/evaluation context. Only then
reopen provider or registry network access.

If immutable content at a digest differs, quarantine the restored set; never
overwrite one side to make the collision disappear.

## Recovery acceptance

Keep the restored daemon on loopback until every row passes:

| Check              | Acceptance evidence                                                                                        |
| ------------------ | ---------------------------------------------------------------------------------------------------------- |
| SQLite             | Database opens, `PRAGMA integrity_check` returns `ok`, and readiness succeeds                              |
| Receipts/snapshots | Every recorded digest route returns the exact backed-up bytes                                              |
| Events             | Replay after the recorded cursor has stable IDs/bytes and no missing earlier checkpoint                    |
| CAS/OCI            | Representative and policy-critical blobs match length and SHA-256; OCI manifests close over existing blobs |
| Trust              | Receipt signature/bindings and TUF state verify at the recorded evaluation time                            |
| Resolution         | A recorded normalized request reproduces request, universe, solution, and unsigned-receipt digests         |
| Materialization    | An isolated fixture prefix is recreated with the same file manifest and no lifecycle execution             |

If one row fails, keep provider and registry egress disabled. Restore a complete
known-good set or reacquire a new snapshot under an explicit policy; do not mix
database, CAS, lifecycle, and trust state from unrelated checkpoints.

## Air-gap transfer

Use canonical snapshot bundles plus OCI Image Layout or CAS objects. Include the
lockfile, receipt/proof/explanation, lifecycle root/events required at the
chosen evaluation time, policy, public keys/TUF root, and a transfer manifest.
The receiving side verifies the transfer manifest, snapshot/record roots, OCI
manifest/blob graph, native artifact sizes/digests, trust evidence, receipt
signature/bindings, and policy before materialization. Mutable registry URLs are
optional hints and are not needed for offline identity.

`npm run demo` is the deterministic offline recovery rehearsal: it consumes
fixtures without public registries and writes an indexed artifact set under
`.demo-output`. `npm run test:e2e` reruns that production path and fails on a
digest, proof, trust, materialization, mode-agreement, mise, event, or
downstream contract mismatch. Operator-specific backup paths cannot be safely
exercised by the repository, so deployments must additionally rehearse the table
above with their real storage and secret-recovery systems.

## Failure and incident handling

- Corrupt or missing catalog metadata: reject the snapshot and reacquire or
  restore a known digest; see [threat model](../security/threat-model.md).
- Yank/quarantine/revocation: preserve history, reduce at an explicit evaluation
  time, re-solve, and require explicit policy for forensic digest access; see
  [lifecycle and policy](../security/lifecycle-policy.md).
- Receipt/signing-key compromise: stop signing, retain affected receipt digests,
  rotate trust configuration, and reissue evidence without rewriting old
  receipts; see
  [incident procedure](https://github.com/OpenPacker-Labs/.github/blob/main/SECURITY.md#incident-procedure).
- TUF/Sigstore/provenance failure: keep the distinct evidence result, deny under
  policy as configured, and follow
  [trust-layer guidance](../security/tuf-sigstore-slsa-sbom.md).
