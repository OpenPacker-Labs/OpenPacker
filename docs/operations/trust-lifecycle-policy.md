# Trust, lifecycle, policy, and receipts

OpenPacker treats trust as typed evidence, not `trusted: true`. OCI/native
digests establish byte identity; OCM describes composition; TUF authenticates
rollback-sensitive repository metadata; Sigstore binds signature identity and
transparency evidence; SLSA describes production; CycloneDX supplies content and
license evidence; lifecycle states eligibility; policy decides whether the facts
are acceptable; a PREX receipt binds one resolution.

## Verification facts

Every evidence result records type, subject digest, evidence reference,
six-state status, verifier/version, evaluation time, policy relevance, and
diagnostics. `not-provided`, `unknown`, `not-applicable`, and `policy-denied`
remain distinct from cryptographic `invalid`. The aggregate decision is
separate.

The shipped trust package provides Ed25519 signing/verification; TUF root,
threshold, expiry, rotation, consistent snapshot, rollback, delegated target,
length and digest checks; offline Sigstore bundle v0.3 identity/signature/log
proof checks; SLSA provenance v1 subject/builder/build-type extraction; and
CycloneDX JSON evidence extraction. Exact supported structures are defined by
the TypeScript interfaces and fixture tests, not by a claim to implement every
format version.

Primary authorities are the
[TUF specification](https://theupdateframework.github.io/specification/latest/),
[Sigstore bundle specification](https://docs.sigstore.dev/about/bundle/),
[SLSA provenance v1](https://slsa.dev/spec/v1.0/provenance),
[in-toto Statement v1](https://github.com/in-toto/attestation/blob/v1.0/spec/v1/statement.md),
and [CycloneDX specification](https://cyclonedx.org/specification/overview/).

## Lifecycle reduction

Lifecycle actions are `published`, `yanked`, `deprecated`, `quarantined`,
`revoked`, `delisted`, `restored`, `promoted`, `removed-from-channel`, and
`ownership-transferred`. Events retain actor, authority, effective/issued time,
optional expiry/replacements, source snapshot, evidence, and external refs.

Reduction sorts by effective time, subject-scope precedence, issued time, and
event ID; checks target match, time, expiry, and authority/action/scope rules;
preserves accepted and rejected history; and hashes the derivation. A restore
requires a prior denial and must be later. The default policy excludes yanked,
quarantined, revoked, and ordinary delisted selection; deprecation is eligible
with warning. Exact yanked/delisted and forensic digest access require explicit
policy.

## Policy

Policy evaluation is canonical and deterministic. It supports required evidence;
yanked/quarantined/revoked/delisted handling; accepted signer and Sigstore
issuer identities; denied licenses; provider/source schemes; target platforms;
artifact/expanded size; semantic-loss severity/codes; exact source snapshot; and
forensic digest materialization. Missing facts yield `indeterminate`; invalid or
policy-denied facts yield `deny`; only satisfied checks yield `allow`. The
policy digest is bound into the receipt.

## Operational verification

1. Pin trusted receipt keys and the initial TUF root outside catalog data.
2. Supply an explicit RFC 3339 evaluation time and exact subject; never let a
   verifier silently read the wall clock.
3. Request named checks. Receipt and artifact checks are built in;
   `tuf-metadata`, `sigstore-bundle`, `slsa-subject`, `cyclonedx-sbom`,
   `lifecycle-eligibility`, `policy`, `oci-descriptors`, and `ocm-integrity`
   require configured verifiers.
4. Persist every typed fact and the separate aggregate decision. Treat
   `not-provided` and `unknown` as absence, not validity.
5. Persist returned TUF trusted versions atomically before accepting the next
   update; otherwise rollback protection is lost.

The offline implementation checks are:

```sh
npm test --workspace @openpacker/trust
npm test --workspace @openpacker/receipts
npm test --workspace @openpacker/policy
npm test --workspace @openpacker/lifecycle
```

Receipt construction and replay protection are detailed in
[Receipts and lockfiles](../protocol/receipts-lockfiles.md). The security-facing
model remains authoritative in [threat model](../security/threat-model.md).
