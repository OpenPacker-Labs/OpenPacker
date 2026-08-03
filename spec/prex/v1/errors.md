# PREX errors

Errors use RFC 9457 `application/problem+json` plus `code`, `retryable`,
optional `correlationId`, `violations`, `explanationRef`, `provider`, and
`upstreamStatus`. The normative schema is
`operations.schema.json#/$defs/Problem`.

Validation and semantic errors are not retryable. `RATE_LIMITED` and
`UPSTREAM_UNAVAILABLE` may be retryable when the provider can safely repeat the
operation. `CANCELLED` is not implicitly retryable. `INTERNAL_ERROR` MUST fail
closed and MUST NOT expose internal details.

Stable codes: `INVALID_PURL`, `INVALID_VERS`, `INVALID_NATIVE_COORDINATE`,
`UNSUPPORTED_ECOSYSTEM`, `UNSUPPORTED_SEMANTICS_PROFILE`, `AMBIGUOUS_IDENTITY`,
`PROVIDER_CAPABILITY_MISSING`, `PACKAGE_NOT_FOUND`, `VERSION_NOT_FOUND`,
`SNAPSHOT_NOT_FOUND`, `SNAPSHOT_MISMATCH`, `UNSATISFIABLE`,
`SEMANTIC_LOSS_REJECTED`, `POLICY_DENIED`, `ARTIFACT_NOT_FOUND`,
`DIGEST_MISMATCH`, `SIZE_MISMATCH`, `STALE_METADATA`, `INVALID_SIGNATURE`,
`PROVENANCE_MISMATCH`, `LIFECYCLE_DENIED`, `RATE_LIMITED`,
`UPSTREAM_UNAVAILABLE`, `CANCELLED`, and `INTERNAL_ERROR`.
