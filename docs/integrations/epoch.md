# Epoch integration

The HTTP consumer/provider contract follows Pact's
[provider verification model](https://docs.pact.io/getting_started/provider_verification).
CloudEvents remain governed by the upstream
[CloudEvents 1.0 specification](https://github.com/cloudevents/spec/blob/v1.0.2/cloudevents/spec.md),
not by Epoch storage choices.

Epoch is a downstream consumer of OpenPacker, not part of PREX. OpenPacker is
authoritative for PREX normalization, canonicalization, solving, proofs,
receipts, and event schemas. Epoch is authoritative for its signed history,
federation, community behavior, and artifact-distribution topology.

The compile-checked neutral integration is
[`examples/epoch-consumer`](../../examples/epoch-consumer). It depends only on
published OpenPacker packages and runs without an Epoch checkout or unpublished
Epoch package.

## Consumption surfaces

- Service: `@openpacker/sdk` calls `openpackerd` and retains raw response and
  event bytes.
- Embedded Node: `@openpacker/embedded` solves and verifies immutable snapshots
  supplied by the consumer.
- Browser: the browser-safe asynchronous WASM binding verifies proofs, receipts,
  and digests without Node polyfills.
- Events: `@openpacker/events` validates CloudEvents 1.0 data digests, canonical
  bytes, IDs, and replay checkpoints.
- Artifacts: PREX artifact, OCI, and OCM descriptors pass to an Epoch-owned
  `ArtifactSource` or `ArtifactSink` without rewriting content digests.
- Contracts: JSON Schema, OpenAPI, AsyncAPI, and the Pact in
  [`pacts`](../../pacts) validate compatibility without source-package coupling.

## Object mapping

| OpenPacker object       | Epoch-owned use                                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `ResolutionReceipt`     | Store as an immutable blob and reference from a signed Epoch operation or event.                                               |
| `ResolutionSolution`    | Attach to build, environment, deployable, or release-intent evidence.                                                          |
| `LifecycleEvent`        | Append as observed package-state evidence without rewriting the OpenPacker event.                                              |
| `ArtifactDescriptor`    | Resolve through Epoch artifact delivery while preserving the OCI digest.                                                       |
| `OCMComponentReference` | Associate the deliverable component graph with an Epoch version or release.                                                    |
| `OpenPackerCloudEvent`  | Persist idempotently by event ID and project into Epoch views.                                                                 |
| `externalRefs`          | Add Epoch event IDs, repository IDs, DIDs, AT URIs, record CIDs, or delivery references outside canonical OpenPacker identity. |

Epoch may mirror or redistribute content only while retaining the original
artifact digest and its receipt relationship. Epoch identities and delivery
locations never become canonical package identity.

## Canonical-byte boundary

`consumeResolution` uses the SDK to solve, requires a signed receipt, validates
it against the PREX schema, verifies the signature locally and through
`/v1/verify`, then retrieves `/v1/receipts/{algorithm}/{digest}`. It rejects a
response unless:

1. the SDK raw response bytes are the canonical signed-envelope bytes;
2. the canonical unsigned receipt bytes reproduce `receiptDigest`; and
3. local and service signature verification both succeed.

Only those unsigned canonical receipt bytes cross
`EpochConsumerPort.persistOpenPackerReceipt`. Returned Epoch references go into
a separate `EpochOwnedEnvelope`; the receipt remains unchanged.

`EpochEventConsumer` verifies each SDK event's exact raw bytes and `datadigest`
before calling the port. It deduplicates by CloudEvent ID and rejects reuse of
one ID with different bytes. The in-memory reference port repeats these checks
at the persistence boundary. The port also loads and monotonically commits the
daemon event cursor after a complete page. A restart therefore resumes from the
committed cursor; replay after a mid-page failure remains safe because event IDs
are idempotent.

`verifyEmbeddedBoundary` solves the supplied immutable universe, independently
checks the proof, compares Rust/WASM and TypeScript canonical proof bytes and
digests, and verifies the unsigned receipt bytes against `receiptDigest`. The
Node compatibility test exercises both direct and asynchronous WASM loading. The
Playwright test loads the real browser WASM module, solves and checks the same
fixture, compares canonical proof bytes, and verifies the receipt digest without
Node polyfills. Service-mode preservation is checked separately against real
`openpackerd` routes.

## Generic external references

[`fixtures/epoch/external-refs.json`](../../fixtures/epoch/external-refs.json)
demonstrates consumer-owned Epoch event, repository, DID, AT URI, record CID,
and delivery references. These references are metadata. They do not alter PURLs,
artifact digests, solution digests, or receipt digests and do not prove
authority by themselves.

## Run and verify

With the fixture daemon listening at `OPENPACKER_URL` and using the committed
`root` receipt key:

```sh
npm run build --workspace @openpacker/example-epoch-consumer
node examples/epoch-consumer/dist/src/demo.js
```

The provider contract runs against a real `openpackerd` base URL:

```sh
npm run test:pact:consumer --workspace @openpacker/example-epoch-consumer
OPENPACKER_URL=http://127.0.0.1:7337 npm run test:pact:provider --workspace @openpacker/example-epoch-consumer
```

The Pact covers discovery, solve, verify, receipt retrieval, event feed, and RFC
9457 errors. Provider verification does not replace daemon integration tests; it
invokes those real routes with deterministic fixture state. Consumer Pact
generation writes only to a temporary directory and compares the formatted
result with the committed Pact, so normal tests never refresh a stale contract
in place.

## Dependency boundary

Production OpenPacker packages, apps, Rust crates, and integrations must not
import or depend on `epoch`, `@epoch/*`, or ATProto packages. Lexicons, PDS,
relay, AppView, CRDT, knot, hold, and spindle implementations are likewise out
of scope. Those strings are permitted only in this documentation, Epoch
fixtures, the neutral example, Pact artifacts, and the boundary test. The
repository boundary test enforces the production-code rule across TypeScript,
JavaScript, Rust, Lua, and package manifests.
