# sdlc-state: nix-versatility

- **Initiative:** Nix-level versatility for the PREX normalized form
- **Phase:** closed
- **Trunk:** main
- **Branch:** `feat/prex-realisation-foundations` → squash-merged `53bdb36` (PR
  #7)

## Goal

Extend the PREX normalized form beyond language-registry packages toward the
versatility of Nix: input-addressed identity, closures with binary-cache
substitution, environments with rollback, and beyond-language packages
(system/toolchain, cross-compilation, multi-output). Scope was design + spec
changes; adapters and installers are follow-on work.

## Delivered (5 commits)

1. **Realisation foundations** — `BuildRecipe` (a captured build plan, never
   executed), `TreeManifest` (whole-tree identity reusing per-file digests
   instead of reimplementing NAR), `SubstituteDescriptor` (binary-cache
   advertisement that locates bytes but never establishes identity), plus
   `ArtifactDescriptor.producedBy` / `treeDigest` / `treeManifestRef` /
   `runtimeReferences`, four digest projections, and ADRs 0023-0025.
   `recipeOutputId` gives output identity that exists before any bytes do.
2. **Outputs and platforms** — `PackageInstance.outputs`, output selectors on
   package expressions, dependency edges, and materialize requests;
   `SolveRequest.platforms` with `build.`/`host.`/`target.` predicate prefixes
   and normative `Requirement.kind` attribution. ADR 0026. The engine, the
   independent checker, and the resolvo path share one platform view so they
   cannot disagree.
3. **Environments** — new `environment.schema.json` with `EnvironmentManifest`,
   an append-only hash-linked `EnvironmentGeneration` chain, and a single
   mutable `EnvironmentState` pointer. Rollback re-points, never rewrites, and
   works without symlinks. Retained generations define collectibility. ADR 0027.
4. **Amendments and nix** — `UniverseAmendment` gives override needs an honest
   home without weakening ADR 0008: bound to an exact metadata digest,
   authority-gated, off by default, and digest-identical when unaccepted. Worked
   `pkg:nix` example: a two-output derivation with its closure. ADRs 0028-0029,
   `docs/integrations/nix.md`.
5. **Fixes found by review** — see "Regressions caught" below.

## Verification

`npm run verify` green (all 22 steps). 106 conformance vectors (was 34), 21
canonical tests including pinned projection digests, and 18 resolver tests
covering cross-platform solving, platform-prefixed predicate resolution,
inactive requirement kinds, and the amendment no-op digest equality. All 19
protocol goldens byte-unchanged: no existing digest moved.

## Regressions caught and fixed during implementation

- The platform work regressed `solver-large-1000-warm` from 13.4s to 22.0s past
  its 20s threshold by rebuilding a platform view per requirement in hot loops.
  Fixed by precomputing both views once per call plus a first-byte fast path;
  back to 13.2s.
- `acceptedAmendmentAuthorities` serialized as `[]` when unset, moving
  `requestDigest`, `policyDigest`, and all 19 goldens. Fixed by skipping the
  field when empty — adding a policy field must never change an existing solve's
  digests.
- Independent review found the resolver emitting an `amendment-ignored`
  explanation node whose `kind` was absent from the closed schema enum, so every
  solve over a universe with an unaccepted amendment produced an invalid
  `SolveResponse`. Fixed and guarded by a vector built from real resolver
  output.
- Review also found the platform code had no test that would fail if it were
  removed. Added cross-platform solve, prefix-resolution, host-equality, and
  inactive-kind tests — the inactive-kind test immediately exposed a real bug
  where dropped requirements still produced proof witnesses the checker
  rejected.
- Re-review closed all ten findings and raised five documentation/auditability
  ones, all addressed: suppressed requirements now emit a
  `requirement-suppressed` explanation node (the same asymmetry this work
  rejected for amendments), the new semantic-loss codes have table rows, and the
  normative prose now states exactly what the reference validator enforces,
  including that output-name uniqueness applies to build recipes as well as
  packages.
- The tree-manifest path pattern was bypassable with an embedded newline
  (`[^\\]` matches newline, `.` does not). Tightened, and the rule is now also
  enforced structurally because the pattern needs lookaheads that some
  non-JavaScript validators lack.

## Follow-on work, implemented and merged as `141ef53` (PR #9)

Everything originally deferred has landed on this branch:

1. **Open ecosystems** — `normalize_purl` is policy-driven per PURL type instead
   of erroring outside npm/cargo/nuget; existing types are byte-identical. The
   TS `Ecosystem` union accepts any PURL type, the daemon takes additional
   codecs, and advertised `purlTypes` derive from the registry.
2. **Amendment compilation** — admitted amendments produce a derived universe
   that search, proof, checker, and oracle all run against;
   `supersedeRequirement`, `retractRequirement`, and `redirectPackage` are
   implemented with `NATIVE_FACT_SUPERSEDED` loss, proof and receipt binding,
   and independent re-derivation so a forged claim is rejected.
3. **`adapter-nix`** — a real codec: store-path parsing matching Nix's
   `parseDrvName`, `compareVersions` ordering (not semver), `nix path-info`
   translation, closure capture, and nixbase32/SRI/hex hash decoding, registered
   in the daemon so `pkg:nix` normalizes end to end. References are recorded as
   the store paths they are; resolving them to node identities is the closure
   assembler's job.
4. **Closures** — `RuntimeClosure` in the schema plus `@openpacker/closure`:
   tree manifests from materialized files, byte-level reference scanning, and
   assembly that keeps declared and observed edges distinguishable.
5. **opm generations** — hash-linked ledger with atomic pointer switch, rollback
   that rebuilds views from the generation record alone, reachability -based
   `gc`, and `opm shell`.

Still out of scope, and stated as such rather than implied: universe
composition, and building or evaluating anything (PREX captures and verifies; it
does not run builders or Nix expressions).

## What review caught that gates did not

`npm run verify` was green at every point below. Each of these was found by
independent review, not by the suite:

- `adapter-nix` emitted `runtimeReferences` entries containing
  `nodeId: undefined as never` and the package's own NAR digest, plus
  `externalRefs` locators naming store paths that do not exist. Removed;
  resolving a reference to an identity belongs to the closure assembler.
- `treeDigest` and `closureDigest` claimed to be the `tree-manifest-v1` and
  `closure-v1` projections while hand-rolling different orderings. Measurably
  different digests, so two conforming implementations would have disagreed.
- A 31-character nixbase32 alphabet (missing `c`) rejected ~81% of real narinfo
  hashes and silently decoded the rest to a **wrong** sha256 written into
  `artifactDigest`. The covering test used a synthetic `c`-free string and
  asserted only shape, so it passed under any alphabet.
- Two guards that did nothing: a containment check applied to a `basename`,
  which can never fail, and an `isEcosystem` guard on a code path the change had
  just stopped using.

The lesson recorded for the next initiative: a green gate is worth only what its
assertions are worth. Every fix above now has a test that fails without it,
confirmed by mutation.
