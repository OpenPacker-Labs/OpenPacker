# SDLC state — reland-after-191

Initiative: put back on `main` what #191 dropped of the stacked PRs merged
before it (#174, #179, #180, #182, #184, #185, #186, #187, #188), land the
follow-ups written since, and land them as one line of PRs, with the fixes found
by running `opm ci` on real projects (real-repos) at its top.

## Phase

closeout — the stack is one line, with real-repos at its top. The full offline
`npm run verify` has run at the top and every failing step is triaged (Gates).
Each PR is ready for its bottom-up squash-merge.

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
| 14    | new  | `real-repos`                              | fixes from `opm ci` on real projects (ADR 0059, ADR 0060)    |

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
- **#206 lands right after #193**, alone (base `main`); it is merged into #205
  (a572f8d), so every head above #205 holds it.
- **real-repos is the line's top.** It was made on #198 (gzip-padding at
  eff44a0) and merged opmx-serve to join the line (460f490); no ADR number
  collides (0059 and 0060 follow 0058).
- **symlinked-base is not in the line.** Its security re-review at 3bdddca
  failed (an environment base inside a project with no project taken). It comes
  back as its own PR on the landed main, with its own verify. Its branch was
  merged with real-repos once (1640248) before that decision; no line branch
  holds any of it.
- **A fix the verify finds goes on the PR that introduced the defect** and is
  merged up the line, never only at the top: c2d73f7 (#196), cca6544 and ec43b31
  (#195), 840627b (#197), 3846cd9 (#194), 5434ef0 (#200), 10a8ffd (#205), and
  earlier a5fb4f2 (#197), a6277e3 (#194), 1043800 (#203), 9be67bb (#205).

## Gates

- Per change: the test that fails without it, run alone (single files, under
  `nice -n 19 ionice -c 3`, isolated `OPM_*`, `XDG_*` and `TMPDIR`).
- Stack top: one full offline `npm run verify` at the top (real-repos), every
  step one at a time with a real TMPDIR, at 9b6a0a1, with the failed steps
  re-run at bd64308 and b316542 after their fixes. Green: every step but `test`.
  `test` fails only on 5 s test timeouts under load (4 CPUs, load 9 to 60, a
  different test each run, each passing alone); `npm test -- --continue` reports
  one such timeout and every other package passing. The Chromium stages ran with
  a short TMPDIR. The table is in each PR's body.
- A linked TMPDIR is refused as on main without symlinked-base (fail-closed);
  the counts at the top are in each PR's body, not counted against the line.
- Hosted CI: billing-refused on every branch since 2026-10-19, `main` included
  ("recent account payments have failed"). Billing-only red; it does not block
  the merge.

## Open items

- symlinked-base (TMPDIR, HOME, XDG and project bases reached through a link,
  the macOS `/var` shape) is outside this line; see Decisions.
- #201's first review's S4 was not kept and is not recoverable; its re-derived
  checks are in #201's body.

## Dispatch log pointer

Outcomes append to `docs/plans/dispatch-log.md`.
