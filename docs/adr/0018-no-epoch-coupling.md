# ADR 0018: Keep Epoch and ATProto out of production dependencies

- Status: Accepted
- Date: 2026-08-02

## Context

Epoch can consume OpenPacker, but its identity, signed history, federation,
community, and delivery topology are not PREX semantics.

## Decision

No production OpenPacker package depends on Epoch, `@epoch/*`, or ATProto.
Epoch-specific material is limited to integration documentation, fixtures,
Pacts, a neutral consumer-port example, and boundary tests. Downstream IDs use
generic `externalRefs` outside canonical package identity.

## Consequences

OpenPacker remains independently useful and vendor-neutral. Epoch can persist
canonical bytes and mirror artifacts without changing their digest relationship.
