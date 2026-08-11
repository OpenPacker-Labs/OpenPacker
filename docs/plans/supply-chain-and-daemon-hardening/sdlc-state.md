# sdlc-state: supply-chain-and-daemon-hardening

- **Initiative:** Take pnpm's supply-chain lessons into PREX, then sweep the
  same defect class through the rest of the codebase
- **Phase:** done
- **Trunk:** main
- **PRs:** #37 `8b1e1bc`, #38 `fc1e737`, #39 `e202959`, #40 `0455869` — all
  squash-merged

## Goal

Capture supply-chain-relevant facts and evaluate them as policy, bound into the
receipt — minimum release age, trust no-downgrade over ordered tiers, exotic
source blocking, lifecycle-script deny-by-default, registry pinning. Then find
the same _class_ of mistake wherever else it lives.

## Layers

### #37 — the honesty gate never ran

`assertWitShapedModule` existed and was called only from tests, so a
config-imported adapter could advertise `install`/`search`/`uninstall` it has no
export for. Discovery now validates what it imports. In-process modules stay
unchecked deliberately: NuGet derives its definition from the live service index
and process start-up should not reach the network.

The unknown-resource rule was also inverted — it accepted any unrecognised
`prex.registry.*` type and rejected vendor-namespaced ones, which is backwards.

### #38 — the headline mitigation was unreachable

The default posture ships `blockExoticSources.transitive = true` and the docs
name it as the answer to dependency injection. But `resolveTransitive` wrote
lock entries with no captured facts and no policy call, and every path that
_did_ evaluate hardcoded `dependencyDepth: 0`. The transitive branch could not
fire. Closure members are now captured at depth ≥ 1 and evaluated; a refusal
fails the resolve instead of being absorbed by the soft-fail.

Five more from the same review:

- `matchesExclude` was a bare `startsWith`, so allowlisting `pkg:npm/left-pad`
  also exempted `pkg:npm/left-pad-installer` from release-age, no-downgrade and
  lifecycle-script denial. Prefixes must now end on a PURL boundary.
- `[policy]` in `opm.toml` failed open: unknown and wrong-typed keys were
  silently dropped, so `trust_polcy = "no-downgrade"` ran with no check while
  the file read as though it had one. Both are now manifest errors.
- Any parseable URL was classified `sourceKind: registry` — the one kind
  `blockExoticSources` never blocks. Registry is now claimed only by callers
  that took the URI from an origin-checked artifact record.
- Transitive entries took the provider's digest on its word while the direct
  path re-derived it. Same check, both paths.
- The trust default landed before an explicit source could override
  `sourceKind`, so a git source inherited the registry tier.

Surfaced a pre-existing bug: `version` in `opm.toml` doubles as pin and range,
and a PyPI pin of `1.0.0` is not a valid PEP 440 specifier, so the whole closure
came back empty through the soft-fail.

### #39 — the same defect class in TUF

Swept for other authority-granting prefix comparisons and found a worse one. A
delegated role scoped to `tools/*` was matched with `startsWith('tools/')`, so
it also held authority over `tools/vendor/backdoor.bin`. TUF matches path
patterns per segment with equal segment counts precisely so a directory
delegation does not become a subtree delegation.

The fail-closed half was not harmless either: a non-matching role is skipped
before `terminating` is considered, so a terminating role scoped to `*` — which
this matcher never matched — terminated nothing and the search fell through.

### #40 — the daemon surface

`Idempotency-Key` was cached by `(method, path, key)` with no record of what was
asked, and consulted before the operation ran, so a reused key with a different
body returned the first response — a signed receipt for a solve the caller never
requested. `handleError` also promoted any thrown value's `code` onto the wire,
so an `ENOENT` reached an unauthenticated caller with a local path attached.

## Decisions

1. **Exclude lists are boundary-matched, never bare prefixes.** They relax a
   mitigation, so a loose match hands the exemption to packages nobody reviewed.
2. **Governance config fails closed.** A misspelled policy key is an error, not
   a weaker policy.
3. **`registry` is a claim about authority, not about URL shape.** Only a caller
   that origin-checked an artifact record may assert it.
4. **All-or-nothing on native pins.** A partial lockfile is how a build silently
   installs something nobody pinned.

## Lesson recorded

Every one of these shipped with `npm run verify` green. Each new test in this
initiative was run against the code it indicts before being kept — three of the
four layers had at least one test that passed against the unfixed code on the
first attempt and had to be rewritten.

## Gate exception

`solver-large-1000-warm-1` blew its 20000ms wall-clock threshold at 39s during
the #39/#40 verify. Not a regression: the benchmark's import graph contains none
of the changed packages, and the same case measured 13282ms earlier the same
session. The machine was carrying sustained external load (~20–40 on 12 cores)
and the measurement tracked it — 39s, 32s, 21.3s, 17.4s as load fell. Merged on
a re-run that was green, not on the assertion. **The threshold has only a 1.5×
margin over its own baseline and will keep flaking on a busy machine.**
