# packslip — signed vendor releases

[packslip](https://packslip.dev) is a signed release manifest a vendor publishes
beside a release (`packslip.sigstore.json`). `opm` consumes it as an ecosystem:
install a tool from its vendor's GitHub release or its own domain, with the
signer checked and **remembered**, and no registry in between.

Decision record: [ADR 0043](../adr/0043-packslip-signed-vendor-releases.md).
Packages: `@openpacker/packslip` (the format and its verification; knows nothing
about opm), `@openpacker/adapter-packslip` (the PREX adapter),
`@openpacker/packslip-testkit` (private test fixtures).

## Use it

```sh
opm init
opm add packslip:jdx/hk                       # newest release; GitHub is assumed
opm add packslip:github.com/jdx/hk@2.5.0      # an exact version
opm add 'pkg:packslip/mise.jdx.dev'           # a vendor on its own domain
opm install
```

| Spec                                | Means                                           |
| ----------------------------------- | ----------------------------------------------- |
| `packslip:jdx/hk`                   | `github.com/jdx/hk` (two segments, none dotted) |
| `packslip:github.com/jdx/hk@2.5.0`  | that project at that exact version              |
| `packslip:mise.jdx.dev`             | a project hosted on its own domain              |
| `pkg:packslip/github.com/jdx/hk`    | the same project as a PURL                      |
| `pkg:packslip/…@1.0.0?variant=musl` | a published build variant (the only qualifier)  |

The expansion to `github.com/…` happens when the spec is read, so the manifest
and the lock always carry the full name that a trust setting is keyed by.

Look before you install:

```sh
opm packslip verify packslip:jdx/hk           # who signed it; installs nothing
opm packslip verify packslip:jdx/hk --json    # the same, for a script
opm versions packslip:jdx/hk                  # eligible versions, newest last
```

```text
pkg:packslip/github.com/jdx/hk@2.5.0
  signer      https://github.com/jdx/hk/.github/workflows/release.yml
  scheme      sigstore-oidc, issuer https://token.actions.githubusercontent.com
  fingerprint ps1_snirenkjwr7m5ozgcufameodnm
  repository  922514152
  logged      yes, a transparency log vouches for the signing time
  signed      2026-…
  trust tier  trusted-publisher
  executables hk
```

## What is checked, every time

A resolution fails closed unless **all** of these hold:

1. The bundle is a valid Sigstore bundle verified against the shipped (or
   operator-supplied) trusted root; a keyless signature carries a transparency
   log entry, and its time is one the verifier vouched for (the log's signed
   timestamp, or a timestamp authority's), not the wall clock and not the
   statement's own `published_at`.
2. The signer is who the project said — or, for a GitHub/GitLab project with no
   configuration, a certificate for **that repository**, issued by the forge's
   own OIDC issuer.
3. The statement is for the project and version asked for, and the version
   matches the tag it was found under.
4. The archive the statement names exists for this host, and the bytes opm
   downloads hash to the digest, and have the size, the **signed** statement
   gives.
5. The host meets the release's hard requirements (or the project said
   `allow_incompatible_host`).
6. The signer is not worse than the one the lock remembers (below).
7. Ordinary opm policy: release age (measured from a verified time, below),
   trust tier no-downgrade, source rules, required evidence.

A vendor's list of releases (a signed `.well-known/packslip.json`) is checked
for expiry and for rollback against the highest sequence the lock has seen.
Withdrawn (`yanked`) releases are never offered; pre-releases only when asked
for by exact version.

## Trust is configured in `opm.toml`

```toml
# A keyless project: hold it to the signer you looked at (opm packslip pin).
[adapters.packslip.trust."github.com/jdx/hk"]
pin = ["ps1_snirenkjwr7m5ozgcufameodnm"]

# A key-signed project: the vendor's minisign public key (bare key line is fine).
[adapters.packslip.trust."example.com/tool"]
public_key = "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3"
allow_unlogged = true        # only if the vendor does not log to Rekor

# A keyless project on its own domain: say exactly who may sign (illustrative).
[adapters.packslip.trust."tools.example.com"]
issuer = "https://token.actions.githubusercontent.com"
identity_prefix = "https://github.com/example/tools/.github/workflows/"
source_repository = "https://github.com/example/tools"

[adapters.packslip]
approvals = []               # proposal ids a person approved (below)
allow_incompatible_host = false
```

| Key (under `trust."<project>"`) | Meaning                                                                              |
| ------------------------------- | ------------------------------------------------------------------------------------ |
| `pin`                           | List of signer fingerprints (`ps1_…`); the certificate must match one                |
| `public_key`                    | Minisign Ed25519 public key for a key-signed project (exclusive of the keyless keys) |
| `identity` / `identity_prefix`  | Exact certificate identity (the workflow URI with its ref), or a prefix of it        |
| `issuer`                        | OIDC issuer; defaults to the forge's for GitHub and GitLab projects                  |
| `source_repository`             | Repository URI the certificate must name                                             |
| `allow_unlogged`                | Accept a key-signed bundle with no transparency-log entry                            |

`identity_prefix` is a plain string prefix. End it at a boundary — a directory
(`…/.github/workflows/`) or the file and its `@` (`…/release.yml@`) — or it also
matches `…/release.yml.evil`. A project's entry matches whatever the case the
name is written in (forge names are case-insensitive). A section such as
`[adapters.packslp…]`, for an adapter that has no settings, is an error: an
ignored `pin` would be a project that trusts whoever signs.

An **unknown key is an error**, reported before any request is made. A
misspelled `pin` that was quietly ignored would be a project that trusts whoever
signs.

Why the manifest and not the lock: the lock is a file anyone with write access
can edit or delete, so it cannot be what says whom to trust. These settings are
part of the manifest digest — changing them makes the lock stale and a frozen
install refuses until you re-resolve.

## What the lock remembers

```jsonc
"attestation": {
  "kind": "packslip",
  "signerIdentity": "https://github.com/jdx/hk/.github/workflows/release.yml",
  "issuer": "https://token.actions.githubusercontent.com",
  "signedAt": "2026-…",
  "signedAtVerified": true,          // a transparency log vouches for it
  "evidence": ["packslip", "sigstore", "sigstore-transparency"],
  "record": { "signer": { "scheme": "sigstore-oidc", "repository_id": "922514152", … }, … },
  "advancing": ["list"]
}
```

It is **evidence for drift detection**, re-derived from the signed bytes on
every resolution; a hand-edited attestation cannot make anything trusted. The
next resolution compares against it, and stops on:

| Change                                              | Approvable?                  |
| --------------------------------------------------- | ---------------------------- |
| A different signer (key, workflow, issuer)          | yes — by proposal id         |
| A weaker signature scheme (keyless → key)           | yes                          |
| The vendor's attestation replaced by a repackager's | yes                          |
| Build provenance or the log entry dropped           | yes                          |
| The workflow pin reduced to a repository pin        | yes                          |
| A **different repository ID** under the same name   | **no** — a different project |
| A signed list older than one already seen           | **no** — rollback            |

A stopped resolution prints a proposal id that names exactly that change:

```text
opm: The trust for github.com/acme/tool changed and needs your approval (proposal 7c1e0a94b2d53f68):
  - The signer changed key: from key 61D25CE860E9C47A to key 9F3B6D0A41C8E2B7
```

```sh
opm packslip approve 7c1e0a94b2d53f68   # records the id in [adapters.packslip].approvals
opm update                              # accepts that change and nothing else
```

An id approves one change. An id for another change, or a later change by the
same signer, is not covered. `advancing` names record keys that legitimately
differ between resolutions of the same release (a list's sequence number); a
frozen install does not compare them, and takes the names from its own fresh
resolution, never from the lock.

For a key-signed project the lock keeps the whole key, not only the key id
printed beside it: the id is a label written into the `.pub` file, so a
different key can carry the same one.

A missing or unreadable lock means no history, never a reason to refuse. It does
switch off what needs history: a changed signer is no longer noticed and a
replayed older list is no longer recognised, so keep `opm.lock.json` committed.
It cannot add trust: the pins, keys and repositories in `opm.toml` are checked
on every resolution whether or not a lock exists.

## Policy facts

| Fact                             | From                                                                  |
| -------------------------------- | --------------------------------------------------------------------- |
| `signerIdentity`                 | The certificate identity without its ref (a key id for key-signed)    |
| `sigstoreIssuer`                 | The certificate's OIDC issuer                                         |
| evidence `packslip`              | The statement and archive were verified                               |
| evidence `sigstore`              | **Keyless only** — Sigstore's PKI vouched for the signer              |
| evidence `sigstore-transparency` | The signature has a verified log entry                                |
| trust tier                       | keyless + logged → `trusted-publisher`; otherwise `registry-attested` |
| `publishedAt`                    | A verified time only (below); absent when none was verified           |
| source kind                      | `registry`: the provider is the authority and the bytes are verified  |

A key the project pinned is that project's anchor, not Sigstore's, so
`required_evidence = ["sigstore"]` is **not** satisfied by a key-signed release.
The `trusted-publisher` tier needs a keyless signature that is logged, bound to
a repository, and made by the vendor for its own release; an email identity or a
repackager's attestation is `registry-attested`.

### Release age, and vendors that do not log

The default policy holds a release for 24 hours (`minimum_release_age_minutes`).
That gate exists for a stolen signing key or CI workflow, which is also the
thing that could write any `published_at` it likes into a statement it signs. So
opm measures a release's age from **a time the verifier vouched for**: the
transparency log's signed timestamp, or a timestamp authority's. The statement's
own date is shown (`statedPublishedAt`) but never used as a clock.

A release with no such time — a key-signed one the vendor did not log, trusted
with `allow_unlogged = true` — has no age opm can establish. Under the default
policy the resolve stops as _indeterminate_ (`POLICY_INDETERMINATE`, exit 6). If
you do trust that vendor, say so for that tool, where a reviewer will see it:

```toml
[policy]
minimum_release_age_minutes = 1440
minimum_release_age_exclude = ["pkg:packslip/example.com/tool"]
```

(`[policy]` is the section `opm init` already wrote; add the one line to it. See
[supply-chain.md](../security/supply-chain.md).)

## Environment

| Variable                        | Meaning                                                                          |
| ------------------------------- | -------------------------------------------------------------------------------- |
| `OPM_PACKSLIP_GITHUB_TOKEN_ENV` | The **name** of the variable holding a GitHub token (rate limits, private repos) |
| `OPM_PACKSLIP_TRUSTED_ROOT`     | Path to a Sigstore `trusted_root.json` replacing the shipped one                 |

The token is read at request time, sent to GitHub's API origin only, and never
stored. If a token _value_ is pasted where a name belongs, opm refuses it
without repeating it.

Network: every request gets its own transport that allows that one origin (plus
GitHub's hosts for a GitHub project, so a download can follow its redirect to
the CDN), resolves the name, refuses private and loopback addresses, and pins
the connection to the address it checked.

## Exit codes

| Code | Name                | packslip causes                                                     |
| ---- | ------------------- | ------------------------------------------------------------------- |
| 3    | invalid input       | Misspelled or malformed trust setting; bad spec                     |
| 4    | not found           | No such version or no artifact for this release                     |
| 5    | unsatisfiable       | Nothing fits this host; a hard requirement is unmet                 |
| 6    | policy denied       | A signer change awaiting approval; archive over the 64 MiB limit    |
| 7    | verification failed | Bad signature, wrong signer, wrong repository, digest/size mismatch |
| 8    | unavailable         | Network failure; `--offline`                                        |

## What opm does not do with a packslip

- **Resources** (completions, man pages, agent skills, CLI specs, SBOMs) are not
  linked into shells or agents. Files inside the archive stay in the store tree.
  Reported as `PACKSLIP_RESOURCES_NOT_INSTALLED` (info).
- **Build provenance** linked from the release is not fetched or verified. A
  packslip authenticates the release statement, not how an artifact was built.
  Reported as `PACKSLIP_PROVENANCE_NOT_VERIFIED` (info).
- **Archives**: `tar.gz`, `tgz`, `zip`, `tar`, at most 64 MiB. A release that
  ships only `tar.xz`/`tar.zst`/a bare binary has no installable artifact.
- **Host requirements** are detected without running anything: operating system,
  architecture, libc. Anything that would need a probe is reported as a warning
  rather than guessed.
- **A rename** is followed through the release statement (the repository ID
  shows it is the same project) but not through a signed release list, which
  must name the project exactly as asked. After a rename, ask for the new name.
- **`opm packslip approve` and `pin --write`** rewrite `opm.toml` with opm's own
  writer, as `opm add` does: comments are not kept. Review the diff.
- **`opmx`** has no project to read trust from, so ephemeral runs work only for
  keyless GitHub projects, which need no configuration.
- Offline replay follows the registry rule: attestation in a lock is not policy
  authority.

## For integrators

```ts
import { detectHost, parseProject, resolveRelease } from '@openpacker/packslip';

const resolved = await resolveRelease({
  project: parseProject('github.com/jdx/hk'),
  request: { spec: 'latest', prerelease: false },
  signer: {}, // or { pins: [...] } / { publicKey: '…' }
  fetcher, // { get(url, { maxBytes, accept }) } — you bound the network
  now: new Date(),
  host: detectHost(),
  formats: ['tar.gz', 'zip'],
});
// resolved.verified.signer, resolved.artifact, resolved.statement, resolved.memory
```

`evaluateTrust(requested, previous, observed, approvals)` is the no-downgrade
rule on its own; `verifyBundle` is the Sigstore step on its own.

## How it is tested

```sh
npm run test --workspace @openpacker/packslip           # vectors, real bundles, properties
npm run test --workspace @openpacker/adapter-packslip   # adapter, including a real keyless release
npm run test --workspace @openpacker/opm-project        # manifest, lock, continuity, policy
PACKSLIP_ORACLE_BIN=/path/to/packslip npm run test --workspace @openpacker/packslip
```

The last one also runs the upstream `packslip` CLI as an oracle over the real
bundles and a set of forged ones; opm must agree with it. Without the variable
those tests are skipped, never faked.
