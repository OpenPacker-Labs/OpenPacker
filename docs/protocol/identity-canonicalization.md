# Identity, PURL, VERS, and canonical bytes

## Identity boundary

A base PURL identifies an ecosystem-qualified package history. An exact PURL
adds an ecosystem version. Aliases, tags, channels, registry URLs, artifact
locations, and external references are mutable locators and never immutable
identity. Native coordinates remain attached so normalization does not erase
ecosystem meaning.

OpenPacker's codecs cover `npm`, `cargo`, `nuget`, `pypi`, `golang`, and
`maven`. The shared parser normalizes PURL type and qualifier keys, rejects
malformed percent encoding and duplicate qualifiers, sorts qualifiers, and
percent-encodes components. Each codec then applies ecosystem case and
coordinate rules. Consumers should send coordinates to `normalize` rather than
constructing PURLs by string concatenation.

Primary specifications:

- [Package URL specification](https://github.com/package-url/purl-spec/blob/main/PURL-SPECIFICATION.rst)
- [ECMA-427: Package URL](https://ecma-international.org/publications-and-standards/standards/ecma-427/)
- [VERS specification](https://github.com/package-url/purl-spec/blob/main/VERSION-RANGE-SPEC.rst)

## Version constraints

`VersionConstraint` retains `scheme`, original text, normalized text, parsed
AST, reversibility, and semantic-loss records. Version comparison and range
membership belong to the ecosystem codec: lexical comparison and generic SemVer
are not substitutes for npm, Cargo, or NuGet ordering.

A native-range-to-VERS translation may be emitted only when it preserves the
accepted version set. Otherwise the native text and AST remain authoritative,
and a structured `SemanticLoss` states what cannot be represented and which
semantics profiles it blocks.

Executable inputs are the positive and negative vectors in
[`fixtures/protocol`](../../fixtures/protocol). The conformance package consumes
the same vectors as the generated TypeScript declarations and checked Rust
models.

## Canonical JSON

PREX uses [RFC 8785 JCS](https://www.rfc-editor.org/rfc/rfc8785.html) with a
bounded I-JSON profile:

- values are null, booleans, strings, arrays, objects, and finite safe integers;
- floating point, negative zero as a distinct value, unsafe integers, lone
  surrogates, cycles, and non-JSON JavaScript values are rejected;
- duplicate object names are rejected before object construction;
- object keys use raw UTF-16 code-unit order; arrays retain schema-defined
  order;
- UTF-8 output contains no insignificant whitespace or trailing newline; and
- canonicalization is idempotent.

There is no generic "strip volatile keys" step. Each enclosing contract names
excluded fields. Correlation and trace headers never enter canonical requests;
receipt signatures are outside `receiptDigest`; mutable artifact locations are
outside artifact content identity.

## Digests

The initial digest algorithm is SHA-256. JSON form is
`{"algorithm":"sha256","value":"<64 lowercase hexadecimal>"}` and string form is
`sha256:<hex>`. Uppercase, wrong length, unsupported algorithms, and non-hex
text fail validation. Protocol digests cover canonical UTF-8 bytes; artifact
digests cover the unchanged native bytes identified by the descriptor.

Normative canonical vectors and their negative cases are under
[`fixtures/protocol/canonical`](../../fixtures/protocol/canonical).
