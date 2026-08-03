# ADR 0004: PREX resolves; OCM composes deliverables

- Status: Accepted
- Date: 2026-08-02

## Context

Dependency selection and portable component delivery overlap but are not the
same model. Duplicating OCM inside PREX would create competing component graphs.

## Decision

PREX represents requirements, capabilities, selected package instances, proofs,
and explanations. OCM component descriptors represent deliverable resources and
component references derived from a selected PREX solution where the mapping is
faithful.

## Consequences

Resolution semantics remain transport-neutral, while OCM descriptors stay
location-independent and compatible with OCM tooling.
