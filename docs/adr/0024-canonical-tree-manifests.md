# ADR 0024: Canonical tree manifests instead of NAR

- Status: Accepted
- Date: 2026-08-03

## Context

Every digest in PREX covered either transport bytes (a native archive) or a
canonical JSON projection. Nothing identified an **extracted directory tree**.
That gap blocks the questions realisation ecosystems ask: are these two
installed outputs the same content, did materialization produce what the recipe
promised, does a binary cache hold the tree I need?

Nix answers this with NAR — a canonical serialization of a directory tree,
hashed. Reimplementing NAR would mean a second serialization format inside a
protocol whose canonicalization story is already settled on RFC 8785 JCS, and
would conflict with the invariant that native bytes are preserved rather than
rewritten.

## Decision

Whole-tree identity is the `tree-manifest-v1` projection digest of a
**`TreeManifest`**: a sorted list of entries carrying path, kind, per-file
SHA-256 digest, and size. It reuses the per-file digests the materializer
already computes, so tree identity is a projection of data PREX had, not a new
hashing pipeline.

Path rules are normative: relative, forward-slash separated, no leading slash,
no empty segment, no `.` or `..` segment, no backslash, no control characters.
The schema pattern enforces them, and the reference validator enforces them
again structurally, because the pattern needs lookaheads that several
non-JavaScript JSON Schema implementations do not support. Entry kinds are
`file`, `executable`, `directory`, and `symlink`; the executable bit is carried
by `kind` rather than a mode integer so trees digest identically across
platforms.

Byte compatibility with Nix NAR hashes is an explicit non-goal. A native NAR is
an ordinary artifact: its bytes get an `ArtifactDescriptor.digest` like any
archive, and a native tree hash may additionally ride in `externalRefs` or
`extensions` when a capture wants to preserve it.

## Consequences

`treeDigest` gives PREX a content identity for unpacked material that is
comparable across ecosystems, verifiable offline, and stable across the platform
differences that break mode-bit-sensitive schemes. Because it is a projection
digest rather than a serialization, it composes with the existing
canonicalization rules and needs no new parser.

The cost is honest and stated: a PREX `treeDigest` cannot be compared to a hash
produced by `nix hash path`. Cross-checking against a native tree hash requires
carrying that native value explicitly.

Symlink entries are representable so that captures stay faithful to what a tree
contained. Materializing one is a separate question: the reference materializer
rejects symlink archive entries today, and a materializer that declines a
symlink entry MUST record `TREE_ENTRY_UNSUPPORTED`. That rule is normative for
implementations; wiring it into `packages/materializer` alongside tree-manifest
production is follow-on work.
