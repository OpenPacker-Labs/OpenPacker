# Native supply-chain capture and mitigation

How OpenPacker **captures** supply-chain-relevant facts and **mitigates** common
attacks without reimplementing every package manager. Lessons are taken from
[pnpm’s supply-chain guidance](https://pnpm.io/supply-chain-security) and mapped
onto PREX’s fact/decision split
([ADR 0013](../adr/0013-separate-trust-layers.md),
[ADR 0033](../adr/0033-native-supply-chain-capture-and-mitigation.md)).

## Capture vs mitigate

| Phase        | Question                                | OpenPacker surface                                                                                      |
| ------------ | --------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **Capture**  | What is true about this package/source? | Catalog inspect, artifact digests, trust evidence, lifecycle events, materialize outcome, semantic loss |
| **Mitigate** | Is that acceptable here?                | `@openpacker/policy` `evaluatePolicy`, bound as `policyDigest` on the receipt                           |

Missing capture never becomes “valid.” A mitigation that needs a missing fact
yields `not-provided` → aggregate **indeterminate** (or **deny** when the check
is hard-denied), not a silent allow.

## pnpm control → PREX mapping

| pnpm                                           | PREX / OpenPacker                                                                    | Notes                                                                                                                               |
| ---------------------------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| Disable postinstall by default (`allowBuilds`) | Materialize never runs lifecycle scripts; policy `allowLifecycleScripts` / allowlist | Execution is a declared capability ([ADR 0031](../adr/0031-prex-is-a-plug-in-interface-for-package-managers.md)); default is refuse |
| Jailed builds (`jailBuilds`)                   | `@openpacker/sandbox` + policy `sandboxMode` / package grants                        | Aube-style jail; MXC preferred, native fallback ([ADR 0036](../adr/0036-sandboxed-installs-and-execution.md))                       |
| `minimumReleaseAge`                            | Policy `minimumReleaseAgeMinutes` + captured `publishedAt` vs `evaluationTime`       | Detection-window quarantine                                                                                                         |
| `trustPolicy: no-downgrade`                    | Policy `trustPolicy: "no-downgrade"` + `trustLevel` / `priorTrustLevel` facts        | Ordered tiers, not a boolean “trusted”                                                                                              |
| `blockExoticSubdeps`                           | Policy `blockExoticSources` + `sourceKind` / `dependencyDepth`                       | Registry vs git/tarball                                                                                                             |
| Named registries in lockfile                   | Registry Definition `registryId`, lock source endpoint, policy expected registry     | Prevents same name/version from another authority                                                                                   |
| Lockfile + frozen install                      | `opm.lock.json` / PREX lock + `requireExactSourceSnapshot`                           | Exact pins; no ambient float                                                                                                        |
| Workspace committed config                     | Project policy + lock in VCS; no secret expansion in registry URLs                   | Governance                                                                                                                          |

## Attack classes and native response

| Attack                                     | Capture                                                              | Mitigate                                                            |
| ------------------------------------------ | -------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Malicious publish in the first hours       | `publishedAt` from registry                                          | `minimumReleaseAgeMinutes` (e.g. 1440)                              |
| Malicious `postinstall`                    | `lifecycleScriptsDeclared`; materialize records scripts not executed | Deny execution unless allowlisted; when allowed, run only in jail   |
| Jail escape / ambient install              | sandbox backend + `SANDBOX_*` losses                                 | fail-closed default; MXC preferred; native fallback; record backend |
| Typosquat / unexpected registry            | `registryId`, provider id, source scheme                             | `allowedProviders`, `allowedSourceSchemes`, expected registry pin   |
| Git/tarball dependency injection           | `sourceKind: git \| tarball`                                         | `blockExoticSources` for transitive (or all) deps                   |
| Trust downgrade (was signed, now unsigned) | `trustLevel` vs `priorTrustLevel`                                    | `trustPolicy: "no-downgrade"`                                       |
| Yank after compromise                      | Lifecycle events                                                     | Lifecycle reduction + `allowYanked: false`                          |
| Digest substitution                        | Artifact digest/size on fetch                                        | Fail closed before extract; CAS content-addressed store             |
| Host installer scripts (apt/choco)         | Semantic loss `SYSTEM_INSTALL_NOT_BYTE_VERIFIED`                     | Cannot claim `native-validated-v1`; elevation consent               |
| Unsandboxed host install                   | Legacy `SYSTEM_INSTALL_NOT_SANDBOXED` evidence                       | Always refuse; legacy ambient policy fields do not execute          |

## Policy profile (configured default)

`opm init` writes this profile into `opm.toml`. Normative knobs live on PREX
`PolicyInput` (schema) and are evaluated by `@openpacker/policy`. Projects
commit them under `[policy]` (no `${ENV}` expansion in registry pins). A local
`file:` / path source has no publish clock, so minimum release age does not
apply to it:

```toml
[policy]
allow_yanked = false
allow_quarantined = false
semantic_loss_maximum = "warning"
minimum_release_age_minutes = 1440
minimum_release_age_strict = false
trust_policy = "no-downgrade"
block_exotic_transitive = true
block_exotic_direct = false
allow_lifecycle_scripts = false
expected_registry_id = "urn:openpacker:registry:npmjs-org"

[sandbox]
enabled = true
mode = "fail-closed"
prefer = "auto"
```

Equivalent JSON `PolicyInput`:

```json
{
  "allowYanked": false,
  "allowQuarantined": false,
  "requiredEvidence": [],
  "semanticLossMaximum": "warning",
  "allowLifecycleScripts": false,
  "minimumReleaseAgeMinutes": 1440,
  "trustPolicy": "no-downgrade",
  "blockExoticSources": { "transitive": true, "direct": false },
  "sandboxMode": "fail-closed",
  "sandboxRequired": true,
  "sandboxPrefer": "auto",
  "allowHostUnsandboxedInstall": false
}
```

Tune excludes (`minimumReleaseAgeExclude`, `trustPolicyExclude`) only for
packages you have reviewed — same spirit as pnpm’s exclude lists. An exclude
entry matches the package id exactly, or as a prefix that ends on a PURL
coordinate boundary (`@`, `/`, `?`, `#`): `pkg:npm/left-pad` does **not** exempt
`pkg:npm/left-pad-installer`, and `pkg:npm/@acme/` exempts that scope.

An unknown or wrong-typed key under `[policy]` is a manifest error, not a
silently weaker policy — a project never runs with less governance than
`opm.toml` reads as.

### Where policy is evaluated

Every selection that reaches `opm.lock.json` is evaluated: direct requirements
at `dependencyDepth` 0 and each member of the resolved closure at depth ≥ 1,
which is what makes `blockExoticSources.transitive` real rather than
aspirational. A policy refusal fails the resolve; it is never absorbed by the
soft-fail that keeps an unresolvable closure from breaking a direct install.

`sourceKind: registry` is claimed only when the URI came from a registry’s own
artifact record whose origin was checked against that ecosystem’s allowlist. Any
other URL that merely parses is `tarball` — an authority has to stand behind a
source before it counts as one.

Prior trust tier is persisted on `opm.lock.json` packages as `trustLevel` so
`trustPolicy: no-downgrade` can compare upgrades against the last selected
release. **First install** (no prior tier in the lock) skips the no-downgrade
check — there is nothing to compare — and allows the candidate when other checks
pass.

Persisted capture fields are upgrade history, not self-authenticating evidence.
An offline lock replay reconstructs package identity, dependency depth, and byte
size from the immutable package projection and re-hashes cached bytes. Source
classification is used only when that exact projection is bound to an explicit
current-manifest source. Registry lifecycle, signer, issuer, evidence-status,
and source-snapshot assertions are accepted only from a verifier capability
bound to the same immutable projection; when that capability cannot be replayed,
policies requiring those facts fail closed.

## Adapter obligations

When a Registry Definition advertises `package-metadata`, inspect SHOULD
populate publish time when the native protocol has it. Where the protocol only
has it in an expensive document (npm: the full packument is 54 MB against 8.7 MB
abbreviated for the 44 packages of one framework's dev tooling), a provider MAY
offer `publishTime(exactPurl, {settledBefore})` and answer with the cheapest
evidence that settles the question: an exact `publishedAt`, or
`publishedNoLaterThan` (an upper bound, such as npm's document `modified`
stamp). The policy accepts the bound one-sidedly: it can clear
`minimumReleaseAgeMinutes` and can never fail it, and an exact `publishedAt`
always outranks it. A bound is never stored as a publish time. When provenance
or trusted-publisher evidence exists, trust tier SHOULD be set from verified
facts only. Exotic coordinates (git, direct URL) MUST set `sourceKind`
accordingly so policy can block them.

A provider reads registry metadata under a byte bound that is applied while the
body arrives, so a missing or understated `Content-Length` does not lift it, and
under a bound on the values the parsed document may hold, one per 16 bytes of
the byte bound, which the parser enforces as it builds the tree: the first value
past the limit is refused before it is built. npm's abbreviated packument is
bounded at 64 MiB and the full one at 96 MiB, above the largest the public
registry serves in the 4,887 packages looked at on 2026-10-12 (36.6 MiB
abbreviated, 73.0 MiB full) and below the 128 MiB an artifact may weigh. Those
are bytes held, per document. What parsing a hostile body costs is separate and
measured, through the real transport and provider on a 4-CPU machine shared with
other work, over fifteen shapes of document and one to five runs of each. For an
abbreviated packument the shape that held the most took 2,169 to 2,683 MiB (2.1
to 2.6 GiB) of peak memory in 22.5 to 30.4 s, and the slowest, a different
shape, took 52.2 to 60.8 s at 1,412 to 1,547 MiB (1.4 to 1.5 GiB). For a full
packument the same two shapes took 3,149 to 3,956 MiB (3.1 to 3.9 GiB) in 37.1
to 44.1 s, and 91.1 to 100 s at 2,244 to 2,347 MiB (2.2 to 2.3 GiB). Counting
values after the parse instead cost 7,442 MiB and 50.7 s for a 64 MiB body of
`{},` in one `json()` call, and the parser stopping at the limit costs 1,108 to
1,121 MiB and 2.0 to 4.4 s for the same body. Those are the heaviest shapes
tried, not a proven maximum, and a later run can fall outside a range. The bound
is on a document and not on a resolve: the provider keeps every packument it has
read until the resolve ends, so a registry that makes a resolve visit many
packages can make it hold more than one document's worth. A refusal names the
package, the size seen and the limit, and a publish time that is missing because
the registry's document was refused says so in the policy message; the text it
repeats from the document is capped and has its control characters removed. See
the
[amendment to ADR 44](../adr/0044-a-closure-is-what-the-host-installs.md#amendment-2026-10-12-the-packument-bound).

Host installers that only advertise `install` still participate: their plans
emit irreversible / non-byte-verified loss, and policy can deny based on that
loss (`deniedSemanticLossCodes` or severity caps).

## Related

- [Threat model](threat-model.md)
- [Lifecycle and policy](lifecycle-policy.md)
- [TUF / Sigstore / SLSA / SBOM](tuf-sigstore-slsa-sbom.md)
- `@openpacker/policy` — `evaluatePolicy`
