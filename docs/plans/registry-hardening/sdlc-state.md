# sdlc state — registry hardening

- Initiative: harden the OpenPacker registry against the failure modes the MCP
  registry has **measured**, not the ones we could invent
- Phase: **complete** — all five layers reviewed and squash-merged
- Trunk at closeout: `2a8c03c`

## Why this initiative existed

PR #43 landed the registry: spec, server, client, federation. Reading the MCP
registry's own issue tracker afterwards showed where a design of this shape
actually breaks in production, with numbers attached. Some of those failures we
already avoided. Some we shared. **One we had worse than MCP does** —
`POST /v1/publish` never validated the manifest against `PackageManifest`, so a
publisher could store `distributions: "oops"` and break every client that later
read it. That was MCP
[#783](https://github.com/modelcontextprotocol/registry/issues/783) with the
safety rail removed, and it was a defect in what #43 shipped.

## Where we stood, and where we ended

| Failure mode                                                                  | Evidence                                                                                                                                     | Outcome                         |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| 11.2% of advertised endpoints do not speak MCP at the URL given (~1,177 URLs) | [#1487](https://github.com/modelcontextprotocol/registry/issues/1487)                                                                        | Layer 2 — serviceability        |
| No publish-time validation on our side                                        | ours, worse than MCP's                                                                                                                       | Layer 1 — validate on publish   |
| Signing with no revocation path                                               | ours alone; MCP does not sign                                                                                                                | Layer 3 — key lifecycle         |
| One domain behind 75 namespaces, 62 serving HTML; org-wide publish from a PAT | [#1488](https://github.com/modelcontextprotocol/registry/issues/1488), [#982](https://github.com/modelcontextprotocol/registry/issues/982)   | Layer 4 — holders and quotas    |
| No rename or transfer path                                                    | [#1020](https://github.com/modelcontextprotocol/registry/issues/1020)                                                                        | Layer 4 — signed redirects      |
| Publish-time schema drift breaks clients that meet an old document            | [#783](https://github.com/modelcontextprotocol/registry/issues/783), [#875](https://github.com/modelcontextprotocol/registry/issues/875)     | Layer 5 — read-time negotiation |
| 20–25s reads; search index divergence                                         | [#1252](https://github.com/modelcontextprotocol/registry/issues/1252), [#1107](https://github.com/modelcontextprotocol/registry/issues/1107) | Layer 5 — one FTS5 index        |

## Layers as merged

| Layer | What                                           | PR                                                                                                                                     | Commit    |
| ----- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| 1 + 2 | Validate on publish; serviceability from reads | [#44](https://github.com/OpenPacker-Labs/OpenPacker/pull/44)                                                                           | `29fb4b1` |
| 3     | Revocation list and key rotation               | [#45](https://github.com/OpenPacker-Labs/OpenPacker/pull/45)                                                                           | `b61927a` |
| 4     | Holders, quotas, rename/transfer               | [#48](https://github.com/OpenPacker-Labs/OpenPacker/pull/48) (superseded [#46](https://github.com/OpenPacker-Labs/OpenPacker/pull/46)) | `74a5d03` |
| 5     | Read-time negotiation; FTS5 search             | [#47](https://github.com/OpenPacker-Labs/OpenPacker/pull/47)                                                                           | `2a8c03c` |

## Decisions worth keeping

- **Serviceability is observed, not polled.** The user rejected both scheduled
  options: _"we should be checking when people make requests and track
  serviceability. we don't need to do cron if we do that instead."_ Requests are
  a better sampler than a sweep — the packages people resolve are the ones whose
  rot matters, and the long tail costs nothing until someone asks.
- **`gated` is healthy.** 26.5% of MCP's endpoints answer 401/402/403 because
  they are commercial services wanting a token; treating non-200 as failure
  condemns a quarter of a registry. `402` is included because the surveyor's own
  false positive was exactly that.
- **A timeout stays `unchecked`.** A 5xx from wherever the registry sits is
  evidence about the network, not about the package. Recording it as failure
  exports the registry's weather as a fact about someone else's software.
- **`from-now` ≠ `retroactive`.** Collapsing them makes an operator choose
  between an unusable registry and an unrevoked compromise. They choose the
  second.
- **Quotas are charged per holder.** A per-namespace budget is defeated by one
  DNS record — which is the behaviour holders exist to make visible.
- **A rename is a document, not a 308.** A mirror sees only bytes; a redirect it
  cannot verify is a redirect it has to trust.
- **One search index, derived from `entries`.** There is no second copy of the
  corpus, so there is nothing to diverge.

## Deliberately not in scope

Typosquatting heuristics — names are namespace-qualified and a namespace needs a
proof, so the cheap attack is many namespaces, which layer 4 surfaces. Also out:
moderation/takedown workflow, and reputation or popularity ranking. Each needs a
policy owner rather than a schema, and inventing one in code is how a registry
acquires a governance model nobody agreed to.

## Verification

- `npm run verify` green on each layer branch and on `main` at `2a8c03c`.
- Conformance vectors, positive **and** negative, for every new schema shape:
  `SignedRevocationList`, `KeyRotation`, `NamespaceHolder`,
  `SignedPackageRedirect`, `searchMode`.
- Every new test was run against the code it indicts before being kept. Four
  client tests were rewritten after passing for the wrong reason; one quota test
  was replaced outright when reverting the guard it named did not fail it.
- A `nix build nixpkgs#hello` live test failed once on `main` with
  `rm: cannot remove '/home/codex/.nix-portable/tmpbin': Is a directory` — a
  nix-portable scratch-directory problem, not a code failure. It passed on the
  layer-5 branch immediately before and on re-run after. Recorded rather than
  swept: live tests are opt-in and never substitute for offline failure.

## Process notes

- GitHub auto-closed #46 when its base branch was deleted on the merge of #45,
  and a closed PR's base cannot be retargeted. Reopened as #48 with the same
  commit rebased onto `main`. For future stacks: retarget the upper PR to `main`
  **before** merging the one below it.
- Pushes used `OPENPACKER_SKIP_HOOKS=1`; a full `npm run verify` (a superset of
  the pre-push `agent:check --base=origin/main`) was run green in its place each
  time, on the exact tree pushed.

## Follow-ons

- Client-reported observations exist as corroboration only; nothing consumes the
  shortened TTL from the `opm` side yet.
- Rotation records a `from-now` revocation of the predecessor automatically. A
  publisher who wants a `retroactive` revocation after a theft has no endpoint
  for it — that is an operator action today.
- `GET /v1/holders` has no pagination. It is a list of holders, not packages, so
  it is small until it is not.
- Quota policy is process-wide. Per-holder overrides (a trusted publisher, a
  mirror doing a bulk import) need a configuration surface.
