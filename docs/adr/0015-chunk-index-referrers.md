# ADR 0015: Keep chunk indexes optional OCI referrers

- Status: Accepted
- Date: 2026-08-02

## Context

Content-defined chunks help caches and delivery systems, but parameters and
indexes may evolve and do not define native package identity.

## Decision

A versioned chunk index is an optional OCI referrer to the unchanged artifact.
It records parameters, ordered byte ranges, chunk digests, and subject digest.
Reconstruction must match the original OCI SHA-256 digest.

## Consequences

Delivery optimization can change independently while canonical native bytes and
identity remain stable. OpenPacker does not implement peer delivery.
