# 43. packslip-signed vendor releases are an ecosystem, and trust lives in the manifest

Date: 2026-10-11

## Status

Accepted.

## Context

[packslip](https://packslip.dev) is a signed release manifest that a vendor
publishes beside a release (`packslip.sigstore.json`): an in-toto statement
inside a Sigstore bundle that lists, for each platform, the archive, its digest,
the executables in it, and what it needs from the host. It is the signature a
consumer can check **without** a registry — a GitHub release, or a vendor's own
domain, is enough.

opm already installs from registries that vouch for an artifact only by
publishing its digest. A packslip says more: _who_ signed, whether a
transparency log recorded it, and — across releases — whether that signer is
still the same one. That last property is the interesting one for a package
manager and the one a digest cannot give.

Four questions had to be settled:

1. What is a packslip release _to opm_ — a registry, a source, or an ecosystem?
2. Who verifies the Sigstore bundle, and against which roots?
3. Where does the decision about _whom to trust_ live?
4. What may be written into the lock without becoming a way to weaken it?

## Decision

- **D1 — An ecosystem, not a registry.** A release is addressed by project name:
  `pkg:packslip/github.com/jdx/hk@2.5.0`, or `packslip:jdx/hk` on the command
  line. The adapter (`@openpacker/adapter-packslip`) implements
  `CatalogProvider` and `EcosystemCodec` exactly as the npm adapter does; opm
  core gains no packslip switch. The format itself — statement, selection,
  discovery, trust rules — lives in a pure library (`@openpacker/packslip`) that
  knows nothing about opm and can be reused.
- **D2 — Verification is Sigstore verification, offline, against a shipped
  root.** Bundles are checked with `sigstore-js` against a TUF-authenticated
  trusted root embedded in the package (its sha256 is pinned in source and
  tested); `OPM_PACKSLIP_TRUSTED_ROOT` replaces it for a private Sigstore. This
  is ADR 0030's _outcome 2_: the primitive is bought, the packslip semantics are
  built. A keyless signature must carry a transparency-log entry, and the
  signing time is a time the verifier itself vouched for — a log entry whose
  signed entry timestamp covers its integration time, or an RFC 3161 timestamp
  from a trusted authority — not the wall clock and not the statement's own
  `published_at`. A log entry that carries a proof but no signed timestamp
  (Rekor v2) has an integration time that is only JSON, and is not believed as a
  time. A key-signed bundle is trusted only when the project named its public
  key; it may be unlogged only when the project says so.
- **D3 — Trust anchors are committed in `opm.toml`, never in the lock.**
  `[adapters.packslip.trust."<project>"]` holds a fingerprint pin
  (`pin = ["ps1_…"]`), a key (`public_key`), or an identity constraint. The lock
  is a file anyone with write access can edit or delete, so it must not be the
  thing that says whom to trust. It is part of the manifest digest, so changing
  trust makes the lock stale. With no entry, a GitHub or GitLab project is
  trusted to the extent the forge can prove: the signing certificate must name
  that repository. Once a release is accepted its repository ID is remembered,
  so a rename is followed and a recreated name is not. A trust entry matches its
  project whatever the case it was written in (forge names are case-insensitive;
  an exactly-matched pin would be skipped in silence), and a section naming an
  adapter that has no settings is an error rather than a setting that never
  applies.
- **D4 — The lock remembers the signer so a change can be noticed.** Each locked
  package records an `attestation` (signer, issuer, signing time, evidence, and
  an opaque `record` the adapter reads back). On the next resolution the adapter
  compares: a changed signer, a weaker signature scheme, a vendor attestation
  replaced by a repackager, dropped provenance, a lost log entry, a reduced
  workflow pin. Any of these **stops the resolve** with a proposal id that names
  exactly that change. A person approves it by adding the id to `approvals`
  (`opm packslip approve <id>`); an id approves one change and nothing else. A
  repository ID that differs from the remembered one is not approvable at all —
  it is a different project. For a key-signed project the whole key is
  remembered (the hash of the public key beside its label), because the label is
  written into the `.pub` file and is not a function of the key. A missing or
  unreadable lock is the same as no history, never a reason to refuse: it
  switches off the checks that need history (signer change, replayed list), so
  deleting the lock cannot make anything _more_ trusted than the manifest's
  anchors already allow, but it does stop opm noticing drift. The anchors
  themselves — pins, keys, the forge's repository — are in the manifest and are
  checked every time.
- **D5 — Evidence is stated honestly.** The adapter reports `sigstore` evidence
  only when Sigstore's PKI vouched for the signer (keyless). A release checked
  against a key the project pinned is reported as `packslip` evidence only, so a
  policy that requires `sigstore` is not satisfied by it. Trust tiers: a keyless
  signature that is logged, bound to a repository, and made by the vendor for
  its own release → `trusted-publisher`; otherwise `registry-attested`.
- **D5a — Release age is measured from a verified time, or not at all.** The
  statement's `published_at` is the signer's own word: a stolen key, or a stolen
  CI workflow, writes whatever date suits it, and believing the date would turn
  the minimum-release-age gate — the control that exists for exactly that
  compromise — into a no-op. The adapter therefore offers policy a `publishedAt`
  only when the verifier authenticated a time (above); the signer's date is kept
  as `statedPublishedAt`, a claim nothing treats as a clock. With no verified
  time (an unlogged key-signed release) policy cannot establish the release's
  age, and under the default policy the resolve stops as indeterminate. A
  project that deliberately trusts such a vendor excuses that one tool with
  `minimum_release_age_exclude`, which is a written, reviewable decision in
  `opm.toml`.
- **D6 — State that advances is kept but not compared.** A vendor's signed list
  carries a sequence number that rises with every release, and the lock keeps it
  so a replayed older list is refused. A frozen install re-resolves and compares
  with the lock, so that number would make every older locked version look stale
  after the vendor's next release. The adapter names such keys (`advancing`);
  the comparison leaves them out, taking the names from the fresh resolution and
  never from the lock under verification.
- **D7 — The network is the adapter's to bound.** Every URL comes from a project
  name or a signed document, so no origin is known in advance. Each request gets
  its own transport that allows that origin (and GitHub's own hosts for GitHub
  projects, so a download may follow its redirect to the CDN), classifies the
  addresses it resolves, and pins the connection to the address it checked. A
  GitHub token is read from the variable _named_ by
  `OPM_PACKSLIP_GITHUB_TOKEN_ENV`, sent to GitHub's API origin only, and never
  stored; a value pasted where a name belongs is refused without being repeated.

## What opm does not do with a packslip

Stated so nobody infers more than was verified:

- **Resources are not installed.** Completions, man pages, agent skills and the
  rest are not linked into shells or agents. The archive is installed whole, so
  files inside it remain in the store tree. Reported as
  `PACKSLIP_RESOURCES_NOT_INSTALLED` (info).
- **Build provenance is not verified.** A packslip authenticates the release
  statement, not how an artifact was built. Linked per-artifact provenance is
  neither fetched nor checked. Reported as `PACKSLIP_PROVENANCE_NOT_VERIFIED`
  (info).
- **Only archives opm unpacks** (`tar.gz`, `tgz`, `zip`, `tar`, at most 64 MiB)
  are installable. A release shipping only `tar.xz`, `tar.zst` or a bare binary
  has no installable artifact and says so.
- **Host requirements are checked, not satisfied.** Operating system,
  architecture and libc are detected without running anything. A hard
  requirement the host does not meet stops the resolve unless the project sets
  `allow_incompatible_host`.
- **No transitive dependencies.** A packslip release is self-contained.
- **A rename is followed through the release statement, not through a signed
  release list.** A statement can show, by repository ID, that a renamed project
  is the one that was pinned. A list carries no such proof, so it must name the
  project exactly as asked: a list signed under a project's new name is refused
  for its old one (`PROJECT_MISMATCH`, fail closed). Ask for the new name.
- **`opmx` has no project**, so only keyless GitHub projects, which need no
  configuration, can be run ephemerally.

## Consequences

- Teams get the first signature check in opm that is about _identity over time_,
  not only about bytes.
- The default manifest policy applies unchanged: release age, no-downgrade of
  trust tier, source-kind rules. Policy facts (`signerIdentity`,
  `sigstoreIssuer`, evidence, trust tier, published time) come from the verified
  attestation, so accepted-identity and accepted-issuer lists work on packslips.
- Offline replay follows the registry rule: an existing lock replays from the
  content-addressed cache, and attestation recorded in a lock is not policy
  authority, so an offline install of a registry-style package is still governed
  by the lifecycle policy.
- Only an in-process adapter that did the verifying can supply an attestation. A
  delegated plugin's inspect answer that carries one is refused whole by the
  wire schema (tested), so a sandboxed plugin cannot vouch for itself.
- opm gains the `@sigstore/verify`, `bundle`, `core` and `protobuf-specs`
  libraries — verification only; there is no TUF client, signing, or network
  code from Sigstore in the install path.
- The lock format gains one optional per-package field; older locks read
  unchanged, and an unknown shape in the field is a hard `INVALID_LOCK`.

## Alternatives rejected

- **Shell out to the `packslip` CLI.** Fastest to build, but it puts a second
  trust root, a second network stack and a second release cadence behind every
  install, and it cannot be bounded by opm's transport guarantees. The CLI is
  used the other way round: as a **test oracle** (see below).
- **Keep trust in the lock** ("trust on first use, remembered"). A remembered
  signer is exactly what a repo-write attacker would rewrite. The lock keeps
  evidence for _drift detection_; the manifest keeps the anchor.
- **Implement Sigstore verification here.** Certificate chain, SCT, Rekor
  inclusion and DSSE are a library's job (ADR 0030); the cost of a subtly wrong
  re-implementation is a signature check that passes when it should not.
- **Model a packslip as a `[registries]` source.** There is no registry endpoint
  to name, and a named source would drag the endpoint allowlist logic in where
  the right answer is a per-request one.

## How this is tested

Correctness is shown four ways rather than one:

1. **Upstream conformance vectors**, vendored unmodified, for tag derivation,
   artifact selection, resource selection, host requirements, signer
   fingerprints and release-list rules.
2. **Real Rekor-logged bundles** — `jdx/hk` 2.5.0 and `packslip` 1.5.1 —
   verified offline against the shipped root.
3. **The reference implementation as an oracle.** The same bundles and a set of
   forged variants are run through the upstream `packslip` CLI
   (`PACKSLIP_ORACLE_BIN`), and opm must agree on accept/refuse and on the facts
   it reports. This is how a signer key id declared in the statement but
   different from the signing key was found and made a refusal.
4. **Mutation checks.** Each security-relevant comparison was removed or
   inverted in turn and the suite was required to fail: continuing past a failed
   verification, the issuer, identity prefix, key pin, log requirement, key
   hint, approval id, pinned repository ID, version/tag agreement, bundle digest
   pin, withdrawn releases, list expiry and rollback, archive digest and size,
   the statement/subject cross-check, host requirements, prerelease selection,
   workflow-pin reduction — and, for the opm integration, evidence honesty,
   trust tier, prior-signer lookup, manifest settings, approvals, what reaches
   policy and the lock, the previous lock on update, strict lock and manifest
   parsing, and exit codes. Version ordering is additionally checked against the
   `semver` package as a property-test oracle.
