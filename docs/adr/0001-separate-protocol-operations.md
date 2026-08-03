# ADR 0001: Separate PREX protocol operations

- Status: Accepted
- Date: 2026-08-02

## Context

Identity lookup, catalog inspection, solving, artifact preparation, evidence
verification, and explanation have different side effects and trust inputs.

## Decision

PREX exposes normalize, identify, enumerate, inspect, solve, materialize,
verify, and explain as separate operations with explicit typed inputs and
outputs. Implementations may compose them but cannot hide one operation's
network, trust, or mutation effects inside another.

## Consequences

Clients can cache and audit each boundary. Solving remains pure and does not
download artifacts. The API is larger, but its behavior is independently
testable and capability discovery can advertise partial implementations.
