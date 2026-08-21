# SDLC state — host-fetch-deferred

Initiative: implement the deferred host-fetch surfaces designed in
[`design.md`](./design.md) (rev. 4). Plugin remains metadata-only; operator pins
and per-origin env _names_ are the only grants for private origins, extra
origins, and credentials.

## Phase

dispatch — layers 01–02 independently verified. Layer 03 (`artifact_origins`) in
flight.

## Backend

Local implementer worktrees (`isolation=worktree`). No Linear; one-shot
contracts are the PR Plan in `design.md`. GitHub issues not created.

## Decisions (from design.md)

- **D1** — `[plugins.<id>] artifact_origins` ∪ `OPM_HOST_FETCH_ORIGINS`.
  `record.endpoint` is not a pin.
- **D2** — Bearer only when origin is pinned **and** a per-origin env name is
  set. `OPM_HOST_FETCH_BEARER` is not a process-wide grant.
- **D2-H** — One extra operator-named header per pinned origin (v1).
- **D3** — Ambient creds forbidden; `--allow-env` of token names refused.
- **D4** — Plugin host-fetch HTTPS-only, including loopback.
- **D5** — Plugin never expands the pin set.
- **D6** — Classify-and-pin via undici `Agent` lookup on the same `fetch`.
- **D6-N** — `OPM_REGISTRY_*` drops hardcoded `ARTIFACT_ORIGINS`.

User-resolved open questions: no require-pin profile; first-party pin-mode now
(undici); extra headers in v1; CDN narrowing in this stack.

## Stack layers

| Layer | Branch                                       | Scope                                                              | PR               |
| ----- | -------------------------------------------- | ------------------------------------------------------------------ | ---------------- |
| 01    | sdlc/host-fetch-deferred-01-pin-mode         | Extract classify-and-pin into BoundedFetchTransport (undici Agent) | verified locally |
| 02    | sdlc/host-fetch-deferred-02-adr              | ADR 0041 decision record                                           | verified locally |
| 03    | sdlc/host-fetch-deferred-03-artifact-origins | `[plugins.<id>] artifact_origins` union env pins                   |                  |
| 04    | sdlc/host-fetch-deferred-04-bearer           | Per-origin bearer + sandbox deny + `--allow-env` refusal           |                  |
| 05    | sdlc/host-fetch-deferred-05-extra-header     | Extra operator header grant                                        |                  |
| 06    | sdlc/host-fetch-deferred-06-honesty          | Ambient-credential honesty tests                                   |                  |
| 07    | sdlc/host-fetch-deferred-07-first-party      | First-party classify-and-pin + CDN narrowing + OCI wrap            |                  |

## Gates

- Per commit: `npm run agent:check:staged` (never bypassed).
- Per PR: rubber-duck + adversarial + independent reviewer, then squash-merge.
- Pre-merge of stack top: `npm run verify`.
- CI is dispatch-only; billing-red does not block merge.

## Dispatch log pointer

Outcomes append to `docs/plans/dispatch-log.md`.
