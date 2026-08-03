# ADR 0013: Keep trust roles separate

- Status: Accepted
- Date: 2026-08-02

## Context

Digests, repository freshness, signer identity, build provenance, inventories,
lifecycle eligibility, composition, and policy answer different questions.

## Decision

OCI, TUF, Sigstore, SLSA, CycloneDX, OCM signatures, lifecycle records, and
policy remain typed independent evidence layers. Each yields a status from
`valid`, `invalid`, `not-provided`, `unknown`, `not-applicable`, or
`policy-denied`; aggregate policy is reported separately.

## Consequences

Missing evidence cannot masquerade as valid. Diagnostics identify the failed
trust role and policy can require precise combinations.
