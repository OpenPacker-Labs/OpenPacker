# Repository and production evidence

This implementation follows the
[TUF specification](https://theupdateframework.github.io/specification/latest/),
[SLSA provenance v1](https://slsa.dev/spec/v1.0/provenance), and
[CycloneDX specification](https://cyclonedx.org/specification/overview/). The
Sigstore verifier is modeled on the
[Sigstore bundle specification](https://docs.sigstore.dev/about/bundle/) but
consumes an OpenPacker-specific offline fixture format
(`application/vnd.openpacker.offline-sigstore-fixture.v1+json`) with Ed25519 JWK
certificates — it cannot parse a real cosign-produced bundle, which uses X.509
DER certificates and a Rekor-canonicalized transparency body.

The TUF verifier starts from a trusted root, enforces role thresholds and
expiry, checks timestamp-to-snapshot and snapshot-to-targets length/hash/version
bindings, rejects rollback, verifies delegated path authorization, and enforces
versioned metadata filenames when consistent snapshots are enabled. Root updates
require both the old and new root thresholds. Persist the returned trusted
versions atomically; discarding them defeats rollback protection.

Offline Sigstore-style verification accepts the fixture bundle format above,
checks the artifact subject, leaf signature, fixture CA signature,
issuer/identity policy, transparency body, inclusion proof, and signed
checkpoint. Production trust roots must come from a separately authenticated
update mechanism.

SLSA v1 statements must use in-toto Statement v1 and contain the selected
artifact SHA-256 subject. Builder ID, build type, and normalized material URIs
are exposed to policy. CycloneDX 1.5+ extraction preserves exact PURLs, hashes,
dependency edges, external references, and distinguishes declared, concluded,
unknown, and missing license evidence.

These are bounded verification surfaces, not online trust discovery. The
Sigstore fixture verifier accepts only the committed OpenPacker offline bundle
format and explicit roots; it does not contact Fulcio or Rekor and does not
interoperate with cosign bundles. The TUF verifier accepts caller-supplied
metadata bytes and prior trusted versions; durable storage is the operator's
responsibility. SLSA and CycloneDX parsing exposes policy facts but does not
establish publisher authority by itself.
