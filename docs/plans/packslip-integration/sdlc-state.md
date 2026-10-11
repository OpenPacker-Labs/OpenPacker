# SDLC state — packslip-integration

Initiative: let `opm` install tools from [packslip](https://packslip.dev) signed
vendor releases, with the signer verified and remembered, and tested hard enough
that the claim "verified" means something. Decision record:
[ADR 0043](../../adr/0043-packslip-signed-vendor-releases.md). User guide:
[packslip](../../integrations/packslip.md).

## Phase

review — implementation complete on `claude/eager-cerf-s4wxv8`; awaiting the
full offline `npm run verify` (see _Verification_) and human review.

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

## Verification

Run in this session (container without the `wasm32` Rust target, running as
root):

- Green: `packages/packslip` (372 + 5 skipped oracle),
  `packages/packslip-testkit`, `packages/adapter-packslip` (119),
  `packages/adapters-default`, `packages/adapter-host`, `packages/adapter-core`,
  `apps/opm/test/packslip`, `packages/opm-project` packslip + settings tests,
  `format:check`, `lint:anti-slop`, `check:licenses`, per-workspace coverage
  thresholds.
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
