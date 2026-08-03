# ADR 0016: Support service and embedded/WASM modes

- Status: Accepted
- Date: 2026-08-02

## Context

Some consumers need managed catalog access and persistence; others require
offline, browser, or in-process verification without a hosted dependency.

## Decision

OpenPacker exposes PREX through `openpackerd` and the TypeScript SDK, and
exposes pure normalization, solve, proof, receipt, and digest operations through
native and WASM bindings over serialized snapshots. All modes share contracts
and canonical vectors.

## Consequences

Deployment topology does not change PREX semantics. Cross-mode digest equality
is an acceptance requirement.
