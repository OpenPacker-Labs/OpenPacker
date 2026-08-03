# ADR 0010: Independently check every solve

- Status: Accepted
- Date: 2026-08-02

## Context

A solver's success result is not evidence that compilation, objectives, or
engine output are correct.

## Decision

Every successful solve emits a proof. A checker that does not reuse the search
decision procedure recomputes requirements, capabilities, conflicts, target
predicates, cardinality, lifecycle, policy, objectives, and canonical digests.
Bounded fixtures also compare the optimum with exhaustive enumeration.

## Consequences

Unchecked or invalid results become `INTERNAL_ERROR`, never partial success.
Proofs are portable evidence and regression tests cover proof mutations.
