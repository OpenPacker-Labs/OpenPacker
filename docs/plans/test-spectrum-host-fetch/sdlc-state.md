# SDLC state — test-spectrum-host-fetch

Initiative: close the test-spectrum and boyscout gaps found while landing
host-fetch-deferred. The designed D1–D6-N/D2-H stack is already on `main`. This
stack does not redesign it.

## Phase

dispatch

## Gaps

Repo inventory already has unit, snapshot, contract, chaos, fuzz, behavior, and
mutation _authorities_. Host-fetch itself is unit-heavy. Snapshots are not
`await`ed (Vitest 3 will fail). A `project-io` staging-substitution test races
to `ENOENT` instead of `UNSAFE_PATH`. Gzip on the undici fetch path is untested.
No host-fetch behavior / mutation / chaos / fuzz oracles.

## Stack layers

| Layer | Branch                                          | Scope                                                             |
| ----- | ----------------------------------------------- | ----------------------------------------------------------------- |
| 01    | sdlc/test-spectrum-01-snapshot-await            | Await Vitest `toMatchFileSnapshot` (Verify-style)                 |
| 02    | sdlc/test-spectrum-02-project-io-flake          | Map staging ENOENT to UNSAFE_PATH                                 |
| 03    | sdlc/test-spectrum-03-gzip-agent                | Gzip decompression still applied on BoundedFetchTransport         |
| 04    | sdlc/test-spectrum-04-host-fetch-snapshots      | Characterization snapshots for pins / redact / first-party policy |
| 05    | sdlc/test-spectrum-05-host-fetch-behavior       | Given/When/Then host-fetch journeys                               |
| 06    | sdlc/test-spectrum-06-host-fetch-mutation-chaos | Pin/token mutants die; transport chaos fail-closed                |
| 07    | sdlc/test-spectrum-07-host-fetch-fuzz           | Deterministic origin-parser fuzz class + inventory oracles        |
