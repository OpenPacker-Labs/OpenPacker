# ADR 0012: Separate solution and receipt digests

- Status: Accepted
- Date: 2026-08-02

## Context

Equivalent valid selections should compare across implementations, while an
audit record must include who produced it and from which exact evidence.

## Decision

`solutionDigest` covers the canonical implementation-independent selected
result. `receiptDigest` additionally binds resolver/build/source provenance and
all resolution context. Signatures are excluded from `receiptDigest`.

## Consequences

Service, native, and WASM modes can prove semantic agreement without erasing
provenance. Receipt re-signing does not alter the unsigned receipt digest.
