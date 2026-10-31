# SDLC state — host-fetch-deferred

Initiative: implement the deferred host-fetch surfaces designed in
[`design.md`](./design.md) (rev. 4). Plugin remains metadata-only; operator pins
and per-origin env _names_ are the only grants for private origins, extra
origins, and credentials.

## Phase

done — seven stacked PRs squash-merged to `main` at `98ebf1c`. Full offline
`npm run verify` was green at stack top. CI is dispatch-only; billing-red did
not block merge. First `verify` hit a flaky `packages/project-io`
`UNSAFE_PATH`/`ENOENT` race (unrelated; green on re-run).

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

| Layer | Branch                                       | Scope                                                              | PR                                                                        |
| ----- | -------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| 01    | sdlc/host-fetch-deferred-01-pin-mode         | Extract classify-and-pin into BoundedFetchTransport (undici Agent) | [#120](https://github.com/OpenPacker-Labs/OpenPacker/pull/120) `55b7f41` |
| 02    | sdlc/host-fetch-deferred-02-adr              | ADR 0041 decision record                                           | [#121](https://github.com/OpenPacker-Labs/OpenPacker/pull/121) `b87b319` |
| 03    | sdlc/host-fetch-deferred-03-artifact-origins | `[plugins.<id>] artifact_origins` union env pins                   | [#122](https://github.com/OpenPacker-Labs/OpenPacker/pull/122) `d319565` |
| 04    | sdlc/host-fetch-deferred-04-bearer           | Per-origin bearer + sandbox deny + `--allow-env` refusal           | [#123](https://github.com/OpenPacker-Labs/OpenPacker/pull/123) `95a381a` |
| 05    | sdlc/host-fetch-deferred-05-extra-header     | Extra operator header grant                                        | [#124](https://github.com/OpenPacker-Labs/OpenPacker/pull/124) `7ef8475` |
| 06    | sdlc/host-fetch-deferred-06-honesty          | Ambient-credential honesty tests                                   | [#125](https://github.com/OpenPacker-Labs/OpenPacker/pull/125) `d934850` |
| 07    | sdlc/host-fetch-deferred-07-first-party      | First-party classify-and-pin + CDN narrowing + OCI wrap            | [#126](https://github.com/OpenPacker-Labs/OpenPacker/pull/126) `98ebf1c` |

## Gates

- Per commit: `npm run agent:check:staged` (never bypassed).
- Per PR: rubber-duck + adversarial + independent reviewer, then squash-merge.
- Pre-merge of stack top: `npm run verify`.
- CI is dispatch-only; billing-red does not block merge.

## Dispatch log pointer

Outcomes append to `docs/plans/dispatch-log.md`.
