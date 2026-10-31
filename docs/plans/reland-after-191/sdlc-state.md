# SDLC state — reland-after-191

Initiative: put back on `main` what #191 dropped of the stacked PRs merged
before it (#174, #179, #180, #182, #184, #185, #186, #187, #188), land the
follow-ups written since, and land them as one line of PRs.

## Phase

closeout — the stack is one line and every PR has had an independent review of
its current code. The full offline `npm run verify` at the stack's top
(opmx-serve, #205) is the last gate; it runs once the machine is quiet.

## Stack layers

Each PR's base is the one before it. Each branch was made one line by merging
the branch below it (signed merge commits, every conflict resolved once and
named in the merge's message).

| Layer | PR   | Branch (`claude/ecstatic-mayer-wbm2c3-…`) | What                                                         |
| ----- | ---- | ----------------------------------------- | ------------------------------------------------------------ |
| 01    | #193 | `restore-174`                             | #174's, #182's and #187's changes main lost                  |
| 02    | #201 | `verify-env`                              | what kept `npm run verify` red on the shared agent machine   |
| 03    | #195 | `pnpm-install`                            | re-land #179: `opm ci` installs a pnpm lock (ADR 0055)       |
| 04    | #199 | `vfix`                                    | re-land #180: shared-store record race, gc ctime             |
| 05    | #200 | `p1`                                      | re-land #188: parse cost and retention bounds (ADR 0044)     |
| 06    | #194 | `opmx-handles`                            | re-land #186: opmx store views and per-run layouts           |
| 07    | #197 | `pnpm-patches`                            | re-land #184: pnpm `patchedDependencies` (ADR 0057)          |
| 08    | #198 | `gzip-padding`                            | re-land #185: gzip padding and tar reader agreement (0058)   |
| 09    | #196 | `papercuts-r5`                            | #182 round 5: crash recovery                                 |
| 10    | #204 | `lease-owner`                             | a lease is judged by the one owner rule                      |
| 11    | #202 | `opmx-installed-deps`                     | an installed npm bin runs from a node_modules of its closure |
| 12    | #203 | `opmx-stream`                             | a tool's output reaches the terminal as it writes it         |
| 13    | #205 | `opmx-serve`                              | a tool runs until it ends or is stopped                      |

## Decisions

- **One line, by merges.** No branch was rebased or force-pushed; each merges
  the one below it, so every PR's diff against its base is its own change.
- **Conflicts with two merge bases.** #179's and #180's branches share an older
  line (99ff5c6), so git reported conflicts in files the incoming branch had not
  changed against its own base. Those take the side that changed.
- **No raised time bound.** #199's 30 s vitest default, its 600 s and 900 s
  scrub bounds, 120 s for the libc parity scenarios, 300 s for the concurrent
  publish test and the raised elapsed bounds are gone; #200's 60 s for the
  default-cost test is gone. `tests/unit/repository.test.mjs` fails a config
  whose bound differs from main's (opm-project 15 s, the gate config 15 s, the
  coverage config 30 s, every other package vitest's 5 s).
- **Stores per test file.** Every test file gets fresh store, cache and plugin
  directories (`tests/support/stores.setup.ts`, from #201); a test that writes
  into a store file can no longer corrupt the caller's shared store.
- **Browser stages need a short TMPDIR** (under about 58 characters): Chromium's
  singleton socket path holds 107 bytes.

## Gates

- Per change: the test that fails without it, run alone (single files, under
  `nice -n 19 ionice -c 3`, isolated `OPM_*`, `XDG_*` and `TMPDIR`).
- Stack top: one full offline `npm run verify` (pending).
- Hosted CI: billing-refused on every branch since 2026-10-19, `main` included
  ("recent account payments have failed"). Billing-only red; it does not block
  the merge.

## Open items

- A branch from `main`, `claude/ecstatic-mayer-wbm2c3-untrusted-urls-bound`,
  replaces the 50 ms wall-clock bound in opm-project's `untrusted-urls.test.ts`.
  Until it lands, that test may fail under load.
- #201's first review's S4 was not kept and is not recoverable; its re-derived
  checks are in #201's body.

## Dispatch log pointer

Outcomes append to `docs/plans/dispatch-log.md`.
