# Repository and production evidence

This implementation follows the
[TUF specification](https://theupdateframework.github.io/specification/latest/),
[Sigstore bundle specification](https://docs.sigstore.dev/about/bundle/),
[SLSA provenance v1](https://slsa.dev/spec/v1.0/provenance), and
[CycloneDX specification](https://cyclonedx.org/specification/overview/).

The TUF verifier starts from a trusted root, enforces role thresholds and
expiry, checks timestamp-to-snapshot and snapshot-to-targets length/hash/version
bindings, rejects rollback, verifies delegated path authorization, and enforces
versioned metadata filenames when consistent snapshots are enabled. Root updates
require both the old and new root thresholds. Persist the returned trusted
versions atomically; discarding them defeats rollback protection.

Offline Sigstore verification accepts bundle v0.3 fixture evidence, checks the
artifact subject, leaf signature, fixture CA signature, issuer/identity policy,
transparency body, inclusion proof, and signed checkpoint. Production trust
roots must come from a separately authenticated update mechanism.

SLSA v1 statements must use in-toto Statement v1 and contain the selected
artifact SHA-256 subject. Builder ID, build type, and normalized material URIs
are exposed to policy. CycloneDX 1.5+ extraction preserves exact PURLs, hashes,
dependency edges, external references, and distinguishes declared, concluded,
unknown, and missing license evidence.

These are bounded verification surfaces, not online trust discovery. The
Sigstore fixture verifier accepts the committed v0.3-shaped offline bundle and
explicit roots; it does not contact Fulcio or Rekor. The TUF verifier accepts
caller-supplied metadata bytes and prior trusted versions; durable storage is
the operator's responsibility. SLSA and CycloneDX parsing exposes policy facts
but does not establish publisher authority by itself.
