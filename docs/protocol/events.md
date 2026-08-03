# CloudEvents and replay

OpenPacker event envelopes conform to
[CloudEvents 1.0](https://github.com/cloudevents/spec/blob/v1.0.2/cloudevents/spec.md)
and carry versioned PREX/OpenPacker data. The AsyncAPI binding is
[`spec/prex/v1/asyncapi.yaml`](../../spec/prex/v1/asyncapi.yaml); data schemas
are under [`packages/events/schemas`](../../packages/events/schemas).

Every event carries `specversion`, stable `type`, unique `id`, source URI,
subject, injected time, JSON data content type, data schema URI, canonical
`datadigest`, correlation and optional causation IDs, plus generic external
references. Immutable fact events may derive identity from their canonical fact
digest. Package observations, lifecycle changes, and policy evaluations require
a distinct occurrence ID.

| Event type                                | Data fact                                  |
| ----------------------------------------- | ------------------------------------------ |
| `org.openpacker.catalog.snapshot.created` | Source snapshot                            |
| `org.openpacker.catalog.package.observed` | Package instance observation               |
| `org.openpacker.lifecycle.changed`        | Lifecycle event                            |
| `org.openpacker.resolution.completed`     | Request, universe, and solution digests    |
| `org.openpacker.resolution.unsatisfiable` | Request, universe, and explanation digests |
| `org.openpacker.receipt.created`          | Receipt digest                             |
| `org.openpacker.artifact.packed`          | Artifact descriptor                        |
| `org.openpacker.artifact.verified`        | Verified artifact descriptor               |
| `org.openpacker.policy.evaluated`         | Subject digest and decision                |

## Reference replay binding

The daemon stores canonical event bytes in a SQLite outbox keyed uniquely by
event ID and ordered by an integer sequence. `GET /v1/events?cursor=N&limit=M`
returns events strictly after `N` as NDJSON and reports the last returned
sequence in `x-openpacker-next-cursor`. Consumers commit a checkpoint only after
applying the page and deduplicate by event ID. Re-requesting a checkpoint is
safe and represents at-least-once delivery.

`@openpacker/sdk` exposes an async `events(cursor)` iterator that returns both
the parsed event and its exact line bytes. `@openpacker/events` verifies the
schema-shaped envelope, canonical data digest, and optional exact canonical
bytes. Downstream persistence must retain those bytes; transport or
consumer-owned references belong outside the canonical event.

The in-memory `EventSink` is the deterministic extension/test implementation.
The protocol does not require Kafka, NATS, or any other broker.
