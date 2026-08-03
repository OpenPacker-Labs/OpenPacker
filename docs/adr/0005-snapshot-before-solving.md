# ADR 0005: Acquire catalogs before pure resolution

- Status: Accepted
- Date: 2026-08-02

## Context

Network order, retries, mutable metadata, clocks, and credentials make live
provider access nondeterministic and unsuitable inside a solver.

## Decision

Providers acquire and normalize records into a complete, immutable, canonical
`ResolutionUniverse` with record and root digests. The resolver accepts only
that snapshot and has no network, filesystem, clock, randomness, credential, or
process access.

## Consequences

Solves are replayable offline and byte-identical inputs can yield byte-identical
results. Catalog construction must enforce bounds and referential integrity.
