# ADR 0014: Use CloudEvents without requiring one event transport

- Status: Accepted
- Date: 2026-08-02

## Context

Consumers need versioned catalog, lifecycle, resolution, receipt, artifact, and
policy events but do not share a broker or persistence topology.

## Decision

OpenPacker emits CloudEvents 1.0-compatible envelopes with versioned data
schemas, canonical data digests, correlation, causation, and generic external
references. An in-process sink and SQLite outbox provide at-least-once replay;
SSE or NDJSON is the reference binding.

## Consequences

Consumers can deduplicate and project events without Kafka, NATS, ATProto, or
another mandatory transport.
