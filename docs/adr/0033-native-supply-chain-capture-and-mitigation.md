# ADR 0033: Native supply-chain capture and mitigation

- Status: Accepted
- Date: 2026-08-04
- Relates to: [ADR 0013](0013-separate-trust-layers.md),
  [ADR 0031](0031-prex-is-a-plug-in-interface-for-package-managers.md),
  [ADR 0032](0032-wit-adapters-and-registry-definition.md)

## Context

Package managers are a primary vector for software supply-chain attacks:
compromised publishes, malicious `postinstall` scripts, exotic transitive
dependencies (git/tarball), registry substitution, and trust-level downgrades
(e.g. a package that used to ship with a trusted publisher now ships unsigned).

[pnpm’s supply-chain guidance](https://pnpm.io/supply-chain-security) is a
practical baseline for _mitigation knobs_:

| pnpm control                         | Intent                                                                    |
| ------------------------------------ | ------------------------------------------------------------------------- |
| `ignoreScripts` / `allowBuilds`      | Do not execute dependency lifecycle scripts unless explicitly allowlisted |
| `minimumReleaseAge`                  | Wait out the detection window before accepting newly published versions   |
| `trustPolicy: no-downgrade`          | Refuse installs when package trust level fell vs prior releases           |
| `blockExoticSubdeps`                 | Block git/URL tarball transitive dependencies                             |
| Named registries in the lockfile     | Pin which registry authority owns a name/version                          |
| Committed lockfile + frozen installs | Prevent silent resolution drift                                           |

OpenPacker already separates **facts** (digests, TUF, Sigstore, SLSA, lifecycle,
semantic loss) from **decisions** (policy). That is stronger than a single
“trusted” boolean — but several pnpm-class _mitigations_ were not yet
first-class policy checks, and adapters were not required to **capture** the
facts those checks need (publish time, trust tier, exotic source, script
intent).

## Decision

1. **Capture is native and fail-closed.** Adapters, catalog snapshots, and
   materialize outcomes MUST emit supply-chain facts when known, and MUST leave
   them `not-provided` / `unknown` when not — never invent validity. Required
   fact classes:

   | Fact                   | Captured from                                                                                         |
   | ---------------------- | ----------------------------------------------------------------------------------------------------- |
   | Byte identity          | artifact digest + size on materialize                                                                 |
   | Publish / release time | registry metadata (`publishedAt`, npm `time`, …)                                                      |
   | Trust tier             | provenance / trusted-publisher / signature evidence                                                   |
   | Source kind            | registry vs git vs tarball URL vs path                                                                |
   | Registry authority     | Registry Definition `registryId` + endpoint identity                                                  |
   | Lifecycle scripts      | declared in package metadata; executed (always false unless policy allows and install path runs them) |
   | Lifecycle eligibility  | yank / quarantine / revoke events                                                                     |

2. **Mitigation is policy, not ambient defaults buried in CLI flags.** Supply-
   chain controls live in the policy document whose digest is bound into the
   receipt (same as existing evidence and lifecycle rules). Reference knobs
   (pnpm-aligned names in prose; PREX field names in code):

   | Mitigation               | Policy field (reference)                                   | Default posture                                                     |
   | ------------------------ | ---------------------------------------------------------- | ------------------------------------------------------------------- |
   | Block dependency scripts | `allowLifecycleScripts` / `allowedLifecycleScriptPackages` | deny execution; `opm init` writes `allow_lifecycle_scripts = false` |
   | Delay new publishes      | `minimumReleaseAgeMinutes` (+ exclude list)                | `opm init` writes 1440; local `file:` / path sources are exempt     |
   | Trust no-downgrade       | `trustPolicy: "no-downgrade"`                              | `opm init` writes no-downgrade; first install has no prior tier     |
   | Block exotic sources     | `blockExoticSources` (+ direct vs transitive)              | `opm init` blocks transitive git/tarball; direct still allowed      |
   | Registry pin             | `requireNamedRegistry` / expected `registryId`             | off until multi-registry                                            |
   | Freeze resolution        | exact lock + `requireExactSourceSnapshot`                  | existing                                                            |

3. **Detection window is a first-class attack assumption.** Compromised packages
   are often removed within hours; a minimum age gate is a temporal quarantine
   that does not require third-party scanners. Scanners remain optional
   enrichment (`provider-*`), never identity.

4. **Trust tiers are ordered evidence, not marketing labels.**

   ```
   trusted-publisher > provenance > registry-attested > unsigned > unknown
   ```

   `no-downgrade` compares the candidate’s tier to a prior selected release’s
   tier for the same package identity. Missing prior tier ⇒ check is
   `not-provided` (indeterminate if policy requires the check), never silent
   allow when the policy is enabled without facts.

5. **Governance is committed configuration.** Project policy and lock digests
   are version-controlled. Secrets never expand into registry URLs in committed
   files (pnpm’s lesson on env expansion in registry settings).

6. **Adapters stay dumb; policy stays pure.** Host package managers (apt, nix,
   winget, chocolatey) declare honesty via Registry Definition features and
   semantic loss. They do not bypass policy: system install still records
   irreversible host mutation as loss and cannot claim byte verification.

## Consequences

- `@openpacker/policy` evaluates supply-chain facts alongside evidence and
  lifecycle. Receipts bind the policy digest that includes those knobs.
- Catalog/inspect paths should populate `publishedAt`, source kind, and trust
  tier when the registry provides them; missing fields stay honest.
- Materialize continues to refuse lifecycle script execution unless a future
  execution capability is both advertised and policy-allowlisted — default deny.
- Operators can express a pnpm-class posture without reimplementing npm:

  ```text
  minimumReleaseAgeMinutes: 1440
  trustPolicy: no-downgrade
  blockExoticSources: { transitive: true }
  allowLifecycleScripts: false
  requireExactSourceSnapshot: true
  ```

- Full promotion of every knob into normative `PolicyInput` schema is follow-on
  where digests and goldens must move in lockstep; the policy package is the
  evaluation authority now.

## Notes

Normative schemas override this ADR on conflict. Worked operational mapping:
[`docs/security/supply-chain.md`](../security/supply-chain.md).
