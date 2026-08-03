# Artifact source and sink authoring

`@openpacker/artifact-model` exposes browser-safe streaming interfaces. An
`ArtifactSource` implements `stat`, `open` with an optional byte range and abort
signal, and `listReferrers`. An `ArtifactSink` implements `putBlob`,
`putManifest`, and `attachReferrer`; an `ArtifactStore` implements both.

## Invariants

- Digests and sizes are checked at every trust boundary. A source never returns
  bytes under a mismatched immutable descriptor.
- Ranges use non-negative safe-integer offsets and optional positive lengths.
  Report `rangeSupported` accurately.
- Implementations stream large objects, honor cancellation, and bound any
  collection fallback.
- Blobs are immutable by digest. A duplicate put succeeds only when the existing
  bytes match.
- Referrers are keyed by subject digest and returned in deterministic order.
- Credentials are resolved at request time from `credentialRef`; they never
  enter descriptors, canonical identity, logs, snapshots, or receipts.
- Redirects must not forward authorization to another origin; filesystem sources
  must reject path escape.

The reference `FilesystemArtifactStore` uses `blobs/sha256`, subject referrer
indexes, and same-filesystem temporary writes. `OciImageLayout` and
`OciRegistryClient` demonstrate OCI implementations. Do not shell out to ORAS
for core behavior.

## Conformance

Describe the extension with ID/version, capabilities (`stat`, `range`, `read`,
`write`, `referrers`), supported PREX versions, configuration schema,
determinism, security boundary, and diagnostics. Run `checkArtifactSource` and
`checkArtifactSink` from `@openpacker/testkit` with known bytes and a canonical
descriptor. Add corruption, truncation, cancellation, range-boundary, duplicate
put, and subject-spoofing checks for the concrete transport.
