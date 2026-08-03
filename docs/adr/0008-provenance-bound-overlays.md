# ADR 0008: Make overlays provenance-bound and policy-controlled

- Status: Accepted
- Date: 2026-08-02

## Context

Native metadata cannot express every cross-ecosystem or virtual-capability
relationship. Editing that metadata would falsely attribute new facts upstream.

## Decision

OpenPacker overlays are separate digest-addressed documents. Each fact retains
publisher, registry, organization, user, or fixture authority and provenance.
Policy decides accepted authorities; conflicts produce diagnostics. Accepted
overlay and policy digests enter the universe and receipt.

## Consequences

Cross-ecosystem semantics are possible without rewriting native truth. An OCI
referrer may transport an overlay without making it package identity.
