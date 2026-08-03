# ADR 0009: Keep Resolvo behind the PREX semantic model

- Status: Accepted
- Date: 2026-08-02

## Context

Resolvo provides maintained CDCL search, but its data types and supported
relations are implementation details rather than the PREX public contract.

## Decision

PREX IR is authoritative. The Rust resolver canonically assigns internal IDs,
compiles faithful relations to Resolvo, and uses explicit clauses or a bounded
companion layer for unsupported relations. Engine types, IDs, and errors never
cross the protocol boundary.

## Consequences

The search engine can be tested or replaced without changing receipts. Clause
source mappings must be retained for explanations and no relation may be
silently discarded.
