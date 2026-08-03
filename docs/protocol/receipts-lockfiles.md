# Receipts and lockfiles

## Receipt purpose

A receipt is audit evidence for one normalized resolution. Its unsigned payload
binds protocol version, normalized request and digest, universe and source
snapshots, target, policy, lifecycle root, semantics profile, objective
ordering, solution, proof, explanation, artifact set, resolver identity/build,
evaluation time, and typed evidence/external references.

`solutionDigest` identifies a canonical valid result independent of resolver
implementation. `receiptDigest` includes source and resolver/build provenance.
They intentionally answer different questions.

## Signing and verification

`receiptDigest` is SHA-256 over the canonical unsigned `ResolutionReceipt`.
Signatures are held in `SignedReceipt.signatures` and excluded from that digest.
Each Ed25519 signature signs the canonical digest string. Verification:

1. recomputes target and policy bindings from the normalized request;
2. checks semantics, objectives, source snapshots, and resolver build evidence;
3. recomputes and compares `receiptDigest`; and
4. verifies every signature against its declared key ID and algorithm.

Replay in a different target, policy, lifecycle root, universe/snapshot,
semantics, objective, solution, or resolver-build context is rejected. External
references may be added only in an enclosing consumer-owned object if doing so
would alter the original receipt bytes.

## `openpacker.lock.json`

The lockfile schema at
[`lockfile.schema.json`](../../spec/prex/v1/schemas/lockfile.schema.json)
contains root requirements, target, semantics profile, objective order, exact
selected PURLs, package/capability edges, immutable OCI descriptors, OCM
references, snapshot digests, lifecycle root, policy, solution, and receipt
digests, plus generic external references.

Mutable download URLs are retrieval hints inside artifact descriptors, not lock
identity. A lockfile must validate, canonicalize deterministically, and retain
the exact PURL/digest relationship. The CLI's `export lock` accepts a complete
`SolveResponse`, derives these bindings, and writes canonical bytes when
`--output` is supplied.

The end-to-end demo writes checked examples to `.demo-output/receipt.json` and
`.demo-output/openpacker.lock.json`; the checked-in schemas, not those generated
run artifacts, define compatibility.
