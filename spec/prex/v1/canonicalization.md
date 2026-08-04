# PREX canonicalization and digests

PREX canonical bytes use RFC 8785 JSON Canonicalization Scheme (JCS), restricted
to I-JSON objects containing `null`, booleans, strings, arrays, objects, and
finite safe integers. Floating-point numbers, `-0` as a distinct semantic value,
integers outside JavaScript's safe range, lone Unicode surrogates, cyclic
values, `undefined`, functions, symbols, and duplicate object member names MUST
be rejected.

Object keys are sorted by raw UTF-16 code units. Arrays retain order unless a
schema explicitly declares canonical set ordering. Strings and numbers use
ECMAScript JSON serialization. No whitespace or trailing newline is present.
Canonicalization is idempotent.

`Digest` is `{ "algorithm": "sha256", "value": "<64 lowercase hex>" }`. Its
string form is `sha256:<hex>`. Implementations MUST reject uppercase,
unsupported algorithms, wrong lengths, and non-hex characters. A digest is
SHA-256 over canonical UTF-8 bytes unless the containing contract explicitly
identifies native artifact bytes instead.

The following fields are excluded before their containing canonical payload is
formed: transport correlation/trace headers, server timing, credentials, receipt
signatures from `receiptDigest`, and mutable artifact locations from artifact
content identity. Exclusion MUST be specified by the enclosing schema; generic
key stripping is forbidden.

Parsers accepting JSON text MUST detect duplicate member names before
constructing an object. A parse/serialize round trip that encounters duplicates
is invalid even when duplicate values are equal.

All protocol values, including declared extension and native-semantics values,
MUST satisfy `CanonicalJsonValue`. A complete protocol document MUST contain no
more than 1,000,000 values and MUST have nesting depth no greater than 64. A
provider MAY advertise smaller limits. Schema validation alone does not enforce
recursive depth; conforming validators MUST perform the bounded traversal before
canonicalization.

## Digest projections

[`digest-projections.json`](digest-projections.json) is the normative,
machine-readable projection registry. Projection steps are performed in order:

1. When `includePaths` is non-empty, construct an object containing only those
   JSON Pointer paths. Missing optional paths are omitted.
2. Remove `excludePaths`; `*` selects every member at one path segment.
3. Sort arrays at `orderedSetPaths` by ascending canonical JCS text using raw
   UTF-16 code-unit order. Arrays not listed retain their semantic order.
4. Canonicalize and hash the projected value.

`request-v1` excludes transport `context`. `universe-v1` excludes the
self-referential `canonicalDigest`. `solution-v1` excludes `solutionDigest`.
`package-node-v1` includes only exact PURL, qualifiers, and native-semantics
version. `artifact-set-v1` hashes `{ "items": [...] }` without mutable
`locations`. `receipt-v1` hashes the complete unsigned `ResolutionReceipt`; the
signed envelope and signatures are outside that preimage. Proof, explanation,
metadata-record, and event-data projections hash their complete projected
objects. Implementations MUST reject unknown projection IDs rather than infer a
projection.

`tree-manifest-v1` hashes a complete `TreeManifest` with entries sorted as a
canonical set, giving one digest per extracted tree regardless of the order a
producer walked the filesystem. Producers MUST reject duplicate normalized entry
paths before hashing: two entries for one path make the manifest ambiguous, not
merely unsorted. `build-recipe-v1` hashes a complete `BuildRecipe`, which
carries no self-digest field, so a recipe's digest is always recomputable from
the recipe alone. `recipe-output-v1` hashes exactly `{outputName, recipeDigest}`
and yields output identity that exists before any bytes do. `substitute-v1`
excludes mutable `locations`, so the same prebuilt content advertised by any
number of mirrors has a single substitute digest.

Golden vectors under `fixtures/protocol/canonical/` are normative executable
examples. Each vector contains input JSON, exact canonical text, and expected
SHA-256 digest. Negative vectors state the required rejection class.
