# ADR 0011: Bind every resolution input into receipts

- Status: Accepted
- Date: 2026-08-02

## Context

A solution can be replayed misleadingly under a different target, policy,
lifecycle state, catalog, objective order, semantics profile, or resolver build.

## Decision

The canonical unsigned receipt binds normalized request, target, policy,
lifecycle root, source snapshots, semantics, objective ordering, solution,
proof, explanation, artifact set, evaluation time, and resolver build identity.
Signatures bind its digest and live in a separate envelope.

## Consequences

Context substitution changes the receipt digest and invalidates signatures.
Receipts are larger but independently auditable and replay-safe.
