# ADR 0007: Use a loss-aware requirement IR

- Status: Accepted
- Date: 2026-08-02

## Context

npm peers, Cargo features and target dependencies, and NuGet target groups do
not fit a single lowest-common-denominator dependency enum.

## Decision

PREX uses discriminated package/capability, conjunction, alternative, negation,
conditional, conflict, and cardinality structures. Native semantics and source
text are retained, and every incomplete translation emits structured
semantic-loss evidence that policy can reject.

## Consequences

Shared reasoning stays explicit without misrepresenting native behavior. The IR
is more detailed but remains bounded, versioned, and independently checked.
