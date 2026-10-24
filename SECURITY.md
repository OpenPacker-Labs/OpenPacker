# OpenPacker security policy

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub private
vulnerability reporting (Security Advisories) for the
`Tyler-R-Kendrick/OpenPacker` repository:

<https://github.com/Tyler-R-Kendrick/OpenPacker/security/advisories/new>

Include the affected version or commit, attack prerequisites, a minimal
reproduction, impact, and any known digest or key IDs. Do not include registry
credentials, tokens, private package bytes, or personal data.

Maintainers must enable private vulnerability reporting in the GitHub repository
under **Settings → Security** (Private vulnerability reporting). This repository
does not publish a security email address. If that private channel cannot be
opened, disclose only the inability to open it in a public issue; do not include
exploit details.

Maintainers will acknowledge a valid private report within 3 business days
through that private channel, coordinate validation and remediation, and publish
an advisory after a fix or documented disposition is available.

## Supply-chain sensitivity

OpenPacker is a package manager. A defect in how a package is selected,
recorded, or installed can affect every consumer of the resulting lock. The
security scope includes:

- resolver, lock, and install paths;
- registry metadata;
- signing; and
- artifact integrity.

## Supported surface

Security fixes target maintained releases and the default branch. PREX is a
draft protocol; callers must negotiate versions/capabilities and must not assume
schema compatibility across unsupported major versions.

## Incident procedure

For compromised metadata, artifact bytes, signing keys, lifecycle authority, or
provider credentials:

1. stop affected publishing/signing/provider access and preserve logs, canonical
   receipts/events, snapshot roots, and artifact digests;
2. quarantine implicated snapshots/artifacts/keys without rewriting immutable
   records;
3. reduce authorized yank/quarantine/revocation events at an explicit evaluation
   time and re-solve affected locks;
4. rotate provider credentials and trust roots/keys through their native
   mechanisms; never edit an old signed receipt;
5. verify restored catalog/CAS/OCI content, receipt replay bindings,
   TUF/Sigstore/SLSA/SBOM evidence, and policy before reopening; and
6. publish the affected digest/version range and recovery evidence without
   leaking secrets.

Exact digest materialization of denied lifecycle state remains unavailable
unless a separate forensic policy explicitly permits it. Trust roles and threat
boundaries are documented in the [threat model](docs/security/threat-model.md);
backup/recovery steps are in
[`docs/operations/backup-airgap-recovery.md`](docs/operations/backup-airgap-recovery.md).
