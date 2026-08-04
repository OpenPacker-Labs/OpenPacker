# sdlc-state: review-followups

- **Initiative:** Resolve the six findings from self-review
- **Phase:** review
- **Trunk:** main
- **Branch:** `fix/review-followups` → PR #11

## Goal

A code, design, and security review of the merged Nix-versatility work (PRs #7
and #9) raised six items. This initiative designs, scopes, and resolves each,
with adversarial and rubber-duck passes per step.

## Items and resolutions

1. **`opm shell` command injection (HIGH, security).** `JSON.stringify` leaves
   `$`, backticks, and backslashes live inside double quotes, so a project
   directory named `demo$(...)` executed under the documented
   `eval "$(opm shell)"`. Now POSIX single-quoted, with a `:`-in-PATH guard.
   Proven against fourteen hostile values that must survive verbatim.
2. **Scanner did not scale (HIGH, performance).** 1000 candidates over 8MB took
   8161ms; a realistic closure would have taken minutes. Rabin-Karp single pass
   per token length: 171ms for the same shape, nearly flat in candidate count.
   Differential-tested against the naive implementation over forty rounds.
3. **gc used direct membership (MEDIUM, correctness).** Both the comment and
   `semantics.md` said reference closure. Now walks the closure, cycle-safe,
   with members able to record references. Nothing populates them today and the
   comment says so; the point is that gc deletes files, so it must compute the
   right thing before transitive dependencies exist.
4. **Four node-ID derivations (MEDIUM, correctness).** Six codecs hashed a bare
   string, the nix codec hashed an object, and `scripts/demo-workflow.mjs` did
   its own — which is why goldens had never conformed. All now use one helper
   that is the `package-node-v1` projection. Goldens went 0/9 → 9/9 conforming,
   pinned by a golden test.
5. **`amend.rs` mirrored the universe struct (MEDIUM, maintainability).** Drift
   would have silently produced a wrong digest. Serializes the real struct with
   the projection's ordered-set sorting, so drift is impossible rather than
   tested.
6. **Duplicated materializer type (LOW).** Aliased to the real type; divergence
   is now a compile error.

## Verification

`npm run verify` green. One property test legitimately broke — it identified
capability providers by node-ID hex prefix, which the derivation change
invalidated. It names them by exact PURL now, which is stable and clearer about
what it asserts.

## Note for the next initiative

Items 1 and 4 were both present while every gate was green, and item 4 had gone
through two prior review rounds without being caught in full. The scanner and
shell fixes were only provable because a measurement and an exploit were written
first. Prefer that order: demonstrate the defect, then fix it, then keep the
demonstration as the test.
