# Deterministic trust fixtures

`keys.json` contains RFC 8032 Ed25519 test vectors and is never production key
material. The offline tests derive byte-identical signed TUF
root/timestamp/snapshot/targets/delegation metadata and Sigstore bundle v0.3
evidence from these keys; no clock, random source, Fulcio, Rekor, registry, or
network service is used.

The TUF fixture pins evaluation time to `2026-01-01T00:00:00Z` and exercises
expiration, rollback, mix-and-match, consistent-snapshot filenames, delegation,
root rotation, and wrong target bytes. The Sigstore fixture cryptographically
verifies its fixture CA statement, artifact signature, identity/issuer policy,
one-leaf transparency proof, and signed checkpoint.
