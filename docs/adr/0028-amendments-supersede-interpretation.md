# ADR 0028: Amendments supersede interpretation, never native truth

- Status: Accepted
- Date: 2026-08-03

## Context

Real deployments need to override dependency resolution. An organization pins a
patched libc everywhere; a security team redirects a package to a fixed fork; a
platform team retracts a requirement that is wrong for their environment. Nix
expresses this with overlays, which are functions that replace attributes
outright.

PREX overlays deliberately cannot do that.
[ADR 0008](0008-provenance-bound-overlays.md) makes them additive: an overlay
may contribute requirements, capabilities, conflicts, and cardinality
constraints, but may never override a native fact by precedence, because
last-writer-wins destroys the provenance that makes a solve auditable. That
constraint is correct and this ADR does not weaken it.

The result was a genuine gap: a real need with no honest way to express it, and
the risk that implementers would smuggle overrides into overlays or into
out-of-band preprocessing where nothing records what changed.

## Decision

Override needs are met by a distinct document type, `UniverseAmendment`, with
different rules from an overlay:

- It is **bound to an exact native state**: `appliesToMetadataDigest` is
  required, so an amendment written against one version of a package's metadata
  cannot silently apply to another.
- It **supersedes interpretation, not facts**. The `PackageInstance` it applies
  to is preserved verbatim. Amendments compile as separate graph facts through
  three operations: `supersedeRequirement`, `retractRequirement` (which must
  carry a justification), and `redirectPackage`.
- It is **authority-gated and off by default**. Amendments apply only to
  authorities listed in `policy.acceptedAmendmentAuthorities`. When that list is
  absent or empty — the default — amendments contribute nothing and the solution
  digest is byte-identical to the same universe without them, so adding an
  amendment can never silently change an existing result.
- Every applied operation MUST record `NATIVE_FACT_SUPERSEDED` semantic loss
  (severity `warning`, blocking `native-validated-v1` for the affected relation)
  and an explanation node, and applied amendment digests are bound into the
  receipt through `amendmentDigests`.

Ignoring an amendment is also recorded: the explanation graph gains an
`amendment-ignored` node naming the authority and operation count. That fact
lives in the explanation rather than the solution because the solution digest
must stay identical to the amendment-free case.

Until amendment compilation is implemented, accepting an amendment authority is
an **error**, not a silent no-op. A resolver that admitted an amendment and then
discarded its operations would produce a result the user believes was amended
when it was not; failing closed is the honest behavior.

## Consequences

Overlay semantics stay intact, and override needs have a home where who said
what, against which exact state, and with what justification are all recoverable
from the record. A reviewer can ask "what would this solve look like without the
amendments" and get an answer by clearing one policy field.

The cost is that PREX amendments are not Nix overlays: they cannot rewrite a
package's attributes, patch its source, or replace its build. Ecosystems needing
that express it by capturing a different universe — a different set of native
facts — rather than by mutating an existing one. Universe composition remains
out of scope.
