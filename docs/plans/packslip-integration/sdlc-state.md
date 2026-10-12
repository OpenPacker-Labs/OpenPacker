# SDLC state — packslip-integration

Initiative: let `opm` install tools from [packslip](https://packslip.dev) signed
vendor releases, with the signer verified and remembered, and tested hard enough
that the claim "verified" means something. Decision record:
[ADR 0043](../../adr/0043-packslip-signed-vendor-releases.md). User guide:
[packslip](../../integrations/packslip.md).

## Phase

finish — implementation complete on `claude/eager-cerf-s4wxv8`; independent
self-review done and its findings fixed (see _Self-review_); landing as one
squash-merged PR. The full offline `npm run verify` could not run in this
container (see _Verification_).

## Backend

Single branch, no Linear, no stack: the work is one coherent change with a pure
library at the bottom and thin adapters above it. Commits are layered so a
reviewer can read them bottom-up: library → test kit → adapter → registration →
opm-project → CLI → docs.

## Decisions

- **D1** — an ecosystem (`pkg:packslip/<project>`), not a registry or a source.
- **D2** — Sigstore verification via `sigstore-js` against a shipped,
  hash-pinned trusted root (ADR 0030 outcome 2: buy the primitive, build the
  semantics).
- **D3** — trust anchors in `opm.toml`
  (`[adapters.packslip.trust."<project>"]`), never in the lock; part of the
  manifest digest.
- **D4** — the lock remembers the signer; any change stops the resolve with a
  proposal id naming exactly that change; repository-ID mismatch and list
  rollback are not approvable.
- **D5** — evidence honesty: `sigstore` only for keyless.
- **D5a** — release age is measured only from a time the verifier vouched for (a
  log entry's signed timestamp, or a timestamp authority); the signer's own
  `published_at` is a claim, not a clock. No verified time → policy cannot
  establish age (`POLICY_INDETERMINATE` by default; a project that trusts an
  unlogged vendor excuses that tool in `minimum_release_age_exclude`).
- **D6** — `advancing` record keys (list sequence) are kept but not compared by
  a frozen install; the names come from the fresh resolution.
- **D7** — per-request classify-and-pin transport; token by env-var name only.

## Findings worth keeping

- The upstream CLI, run as an oracle, refuses a statement whose declared
  `key_id` differs from the signing key; opm originally accepted it. Fixed in
  `verifyBundle`.
- A frozen install compares a fresh resolution to the lock. A signed list's
  sequence rises with every release, so storing it in the compared record would
  have broken every older locked version after the vendor's next release. Fixed
  with `advancing`.
- Refusing a token-variable setting echoed the value, and the likeliest mistake
  is pasting the token itself. Fixed; regression-tested.
- Reporting `sigstore` evidence for a key the project pinned would have
  satisfied a policy that requires Sigstore's PKI. Fixed.
- `..` passed the first draft of the `packslip:` spec segment check.
- Mutation checks found one real gap (configuration errors surfacing without a
  stable code); closed.

## Self-review

Four independent read-only reviewers (library, adapter, opm integration,
docs/tests claims) went over the branch, each reproducing before reporting.
Confirmed and fixed here:

- **High — a signer could defeat the release-age gate.** Cooldown used the
  statement's `published_at` (signer-controlled), and the "log time" came from
  unauthenticated JSON for a proof-only (Rekor v2) entry. Now only a verified
  timestamp counts; none means age cannot be shown (fails closed). Tests build a
  throwaway log (`generateTestLog`, `signLoggedBundle`) and also forge an entry.
- **High — prototype pollution from a plain `opm.toml`**: a `"__proto__"` trust
  entry wrote onto `Object.prototype` and could flip sandbox settings. Adapter
  tables are now null-prototype with own-property checks, `__proto__` is
  refused, and `[adapters.<x>]` must name an adapter that has settings (a
  misspelled ecosystem silently dropped a pin).
- Medium: key-signed continuity compared the minisign key _label_; the key hint
  is now remembered. `trusted-publisher` required only keyless+logged; it now
  needs a repository-bound vendor attestation. `withoutRef` cut email identities
  at `@`. A pin spelled in another case was skipped; trust keys are now
  case-insensitive. Manifest rewrites (`approve`, `pin --write`) turned
  `[sandbox.packages."pkg:npm/sharp"]` into `pkg_npm_sharp`; the key is
  preserved.
- Low: empty `identity_prefix` passed the "must say who may sign" guard; a
  mid-body network drop escaped unclassified; the snapshot depended on cache
  warmth; the resolution cache never evicted; the 30 s transport timeout covered
  a 64 MiB body; `identify` leaked a raw error; `--write` swallowed the spec;
  `--write=false` wrote; an `approvals` scalar was dropped; an unreadable lock
  blocked `sync`/`add`; `INVALID_PROVIDER_METADATA` was remapped for every
  registry (now a packslip-only code); `opmx` lacked the packslip exit codes;
  `"__proto__"` in a lock record surfaced as an internal error.

Decided not to change (recorded so nobody re-finds them as new):

- A signed release list must name the project exactly as asked, so a rename is
  followed through statements but not lists (fail closed, documented, pinned by
  a test).
- `api.github.com` is pinned so the token can be sent; pinning skips
  private-address classification for that origin (a hostile resolver would still
  need a valid TLS certificate for it).
- The resolution cache key omits the clock and host; TTL is 5 minutes of wall
  clock. Injected clocks in tests must not share a network.
- opm's hand-rolled TOML writer drops comments and has pre-existing edge cases
  (backslash-ended array elements, huge numbers); `[policy]` cannot set accepted
  identities/issuers; version ranges in `opm.toml` are ignored. None are new.
- `SSRF`/token-config refusals in the adapter surface as `UPSTREAM_UNAVAILABLE`
  (cause text kept).

## CI

`ci-build.yml` was red on the base commit; two of its causes are fixed here
(ported from the parallel stack): `npm ci` on Node 22.13 fails `undici`'s engine
check (matrix floor now 22.19.0), and the pack step wrote to a directory it had
not created (`mkdir -p`, `shell: bash`). Remaining red legs are **not billing**:
Windows/macOS `project-io` failures (`koffi` missing; `/dev/fd` path) that
reproduce on the base commit. They are recorded on the PR, not waved through as
billing.

## Verification

Run in this session (container without the `wasm32` Rust target, running as
root):

- Green: `packages/packslip` (389 + 5 skipped oracle),
  `packages/packslip-testkit`, `packages/adapter-packslip` (137),
  `packages/adapters-default`, `packages/adapter-host`, `packages/adapter-core`,
  `apps/opm/test/packslip` (42), `packages/opm-project` (430 of 431; the one
  failure is the root-ignores-read-only test), `packages/plugin-host`,
  `test:docs`, `check:test-inventory`, `format:check`, `lint:anti-slop`,
  `check:licenses`, per-workspace coverage thresholds.
- Not runnable here, and not caused by this change: `@openpacker/embedded`
  (needs `wasm32-unknown-unknown`), so transitive-solver tests in `opm-project`,
  `examples/*`, `apps/openpackerd` and `check:test-inventory` for those
  examples; the sandbox-enforcement test in `apps/opm` (no jail backend); the
  shared-store read-only test (root ignores read-only).
- Oracle tests need `PACKSLIP_ORACLE_BIN`; they were run against `packslip`
  1.5.1 and skip otherwise.

## Open follow-ups

- Install resources (completions, man pages, skills) into the project
  environment (currently declared, not installed).
- Fetch and verify per-artifact build provenance linked from a release.
- `tar.xz` / `tar.zst` unpacking in the materializer would widen the set of
  installable releases.
- Settings for `opmx` (no project to read trust from).
