# sdlc-state: capability-honesty

- **Initiative:** Capability-honesty audit remediation
- **Phase:** closed
- **Trunk:** main
- **Session:** 2026-08-03 (single-session audit → remediation → land)

## Summary

A three-pass capability audit (claims catalog, implementation reality, test/gate
audit) found the repo's headline claims outrunning its code in six material
places. This initiative fixed the dishonest surfaces rather than the missing
features; feature-scale gaps (solver ≥22-node optimization, real Maven
repository inspection) are documented as limitations, not fixed.

## Delivered (one PR, squash-merged)

1. `verify` unbreak: `.opm/` ignored by prettier + git (docs-following
   developers no longer break step 1 of 22).
2. Daemon `GET /v1/capabilities` derives `evidenceTypes` from configured
   verifiers/signers/artifact source; auth advertised as `none` only.
3. CLI `verify` fail-closed exit codes: allow→0, deny→7 (policy-denied→6),
   indeterminate→8, missing decision→9.
4. Go adapter: `.mod` 404/410 → `GOLANG_MOD_NOT_AVAILABLE` warning; other
   failures → `UPSTREAM_UNAVAILABLE` (no more silent empty dependency lists).
5. Lock import: no fabricated `sha256:000…0` digests
   (`NATIVE_DIGEST_NOT_REPRESENTED` loss instead), lifecycle captured as
   `unknown` + `LIFECYCLE_NOT_CAPTURED` warning, real empty-set `lifecycleRoot`.
6. Sigstore fixture format renamed to
   `application/vnd.openpacker.offline-sigstore-fixture.v1+json` (no longer
   wears cosign's real media type); goldens regenerated.
7. Gates: opm added to security+integration gates; fail-closed negative tests
   (digest/size mismatch, tampered catalog, offline refusal, CLI exit codes);
   boundary test executes all 11 archive-exploit vectors; fake `lint` alias
   removed from 37 manifests + verify + turbo; docs-smoke evidence manifest is
   load-bearing (v2 schema: executedBySmoke / coveredByVerify).
8. Docs honesty: opm scope (local/catalog sources only, no transitive
   resolution), lock-import digest honesty, 3-vs-6 ecosystem contradiction,
   Maven/uv caveats, verify exit-code contract.

## Verification

`npm run verify` (all 22 steps) green locally after the changes, including demo,
golden regeneration, benchmarks, and fuzz replay.

## Residuals (documented limitations, not defects)

- Solver optimizing objectives remain bounded to 22 companion nodes
  (`MAX_COMPANION_NODES`); spec hedges already exist.
- Maven provider still requires OpenPacker catalog sidecars (documented in
  `docs/product/reference-implementation.md`).
- opm remains local/catalog-source-only by design (documented in README +
  `docs/guides/opm.md`).
