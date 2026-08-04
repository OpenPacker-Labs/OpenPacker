# sdlc-state: review-followups

- **Initiative:** Resolve the six findings from self-review
- **Phase:** done
- **Trunk:** main
- **Branch:** `fix/review-followups` → PR #11 → squash-merged `0c855a9`

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

## Adversarial review of the fixes

An independent review was asked to break the fixes rather than re-litigate the
findings. It confirmed three (shell quoting, the scanner, the type alias) and
broke three, raising ten items in total. All are resolved.

- **Node identity was 4/6 producers, not 6/6.** `lock-import` had its own
  derivation — `sha256(exactPurl)` — so every package of every imported lockfile
  violated `package-node-v1`, across the six ecosystems shipped as
  `npm run demo:lock-import`. `adapter-maven` called the helper without
  qualifiers while its identity carries `type` and `classifier`, so any non-jar
  packaging or classifier produced the projection of a different identity. The
  golden test could see neither: it walks npm, cargo and nuget instances that
  all have empty qualifiers.
- **The gc closure fix was incomplete in three ways.** Edges keyed by member
  alias cannot express a chain deeper than one hop; they were overwritten rather
  than merged; and they lived in generation records, which gc deletes, so a
  second gc collected what the first had correctly kept. Edges are a fact about
  bytes on disk, so they now live beside the store.
- **The `amend.rs` fix introduced a worse bug than it removed.** Sorting ordered
  sets by UTF-8 bytes disagrees with the normative UTF-16 ordering for non-BMP
  characters — the hazard `canonical.rs` already guards for object names. The
  test that appeared to pin the sort had no array longer than one element and
  used a third serialization as its oracle.
- Also: the closure tests drew "random" data from an LCG's low bits, giving
  period-2 corpora and 32 distinct tokens where 1000 were claimed; the
  `:`-in-PATH check sat in the one consumer that quoted, so `--json` bypassed
  it; the handback report described the previous initiative.

Each new test was run against the code it indicts. The two node-identity tests
fail on the previous derivations while the golden test still passes; the
collation test fails under byte sorting; the gc tests fail under the previous
walk.

## Verification

`npm run verify` green. One property test legitimately broke — it identified
capability providers by node-ID hex prefix, which the derivation change
invalidated. It names them by exact PURL now, which is stable and clearer about
what it asserts.

## Note for the next initiative

Every defect in this initiative — the original six and the ten found against
their fixes — was present while `npm run verify` was green. Item 4 survived
three review rounds because each round's test was satisfied by the bug.

The pattern is specific enough to act on: a test written from the same
understanding that produced the code inherits its blind spot. The golden node-ID
test covered three ecosystems with empty qualifiers, which is exactly the shape
that cannot distinguish the two derivations. The gc test covered depth 1, which
is exactly the depth a non-transitive walk gets right. The closure "1000
candidates" were 32 rotations of one string.

So: run every new test against the code it indicts, and keep it only if it
fails. That check is cheap and it caught all four of this round's tests being
worth keeping — and it is the only thing that would have caught the earlier ones
being worthless.
