# sdlc-state: nix-versatility

- **Initiative:** Nix-level versatility for the PREX normalized form
- **Phase:** closed
- **Trunk:** main
- **Branch:** `feat/prex-realisation-foundations`

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
5. **Performance + digest stability fixes** — see "Regressions caught" below.

## Verification

`npm run verify` green (all 22 steps). 98 conformance vectors (was 34), 21
canonical tests including pinned projection digests, 13 resolver tests including
cross-platform and amendment no-op proofs. All 19 protocol goldens
byte-unchanged: no existing digest moved.

## Regressions caught and fixed during implementation

- The platform work regressed `solver-large-1000-warm` from 13.4s to 22.0s past
  its 20s threshold by rebuilding a platform view per requirement in hot loops.
  Fixed by precomputing both views once per call plus a first-byte fast path;
  back to 13.2s.
- `acceptedAmendmentAuthorities` serialized as `[]` when unset, moving
  `requestDigest`, `policyDigest`, and all 19 goldens. Fixed by skipping the
  field when empty — adding a policy field must never change an existing solve's
  digests.

## Deferred (named follow-on initiatives)

`adapter-nix` codec capturing from `nix path-info --json` /
`nix derivation show` / narinfo; reference scanning and closure assembly in
materialize/verify; amendment compilation (currently fails closed when an
authority is accepted); opm generations, `opm shell`, and garbage collection;
widening the closed TS `Ecosystem` union and the Rust `normalize.rs`
npm/cargo/nuget allowlist; universe composition.
