# PREX package manifest

One document naming a package and every ecosystem it ships to. Schema:
[`schemas/package-manifest.schema.json`](schemas/package-manifest.schema.json).

## Why this shape

The
[MCP registry's `server.json`](https://github.com/modelcontextprotocol/registry)
solved the same problem for MCP servers: a server is one thing, but it is
obtainable as an npm package, a PyPI package, a NuGet package or an OCI image,
and a client needs one document that says so. Its `packages[]` array — each
entry carrying `registryType`, `registryBaseUrl`, `identifier`, `version`,
`fileSha256` and a `runtimeHint` — is the right structure, and this borrows it.

Three things are deliberately different, because PREX already has better
answers:

| `server.json`                        | PREX package manifest                                    | Why                                                                                                                           |
| ------------------------------------ | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `fileSha256`, a bare hex string      | `digest`, a `Digest` with `algorithm` and `value`        | The algorithm is stated rather than assumed, so agility is possible and a mismatched pair is a schema error rather than a bug |
| `registryType`, a private vocabulary | `purlType`, the PURL type PREX uses everywhere else      | One naming scheme to keep in step instead of two                                                                              |
| `registryBaseUrl` alone              | `registryId` **and** `registryBaseUrl`                   | A URL says where to look; an id says who answered, and that is what a policy can pin                                          |
| `_meta` publisher-provided blob      | `provenance` with snapshot, receipt, policy and evidence | The difference between a claim and a verification                                                                             |

`nativeIntegrity` sits beside `digest` rather than replacing it: a consumer
writing a `package-lock.json` needs npm's SRI string, and a consumer verifying
identity needs the sha256. Neither substitutes for the other.

## Provenance says what was checked

`provenance.verified` lists what was actually verified when the manifest was
produced — `artifact-digest`, `native-integrity`, `registry-identity`,
`receipt-signature`, `supply-chain-policy`. An empty list is the honest answer
for a manifest assembled from a lockfile without re-hashing anything, and it is
what `opm manifest` emits until bytes exist to hash.

`receiptDigest` is what makes the versions checkable rather than asserted: the
resolution that produced them is a document with its own digest, and a consumer
can fetch it.

## External registry providers

`registries[]` describes the sources the distributions come from, each by
`registryId`, with a `serviceIndex` locating its
[Registry Definition](registry-definition.md) and a `definitionDigest` pinning
the capabilities it advertised at the time. A registry that later advertises
something different is a different answer, and the digest is what makes that
visible rather than silent.

This is the seam an OpenPacker registry builds on: a registry serves package
manifests, and a client that trusts a registry is trusting a named authority
whose capabilities are themselves a pinned document.

## Producing one

`opm manifest` assembles it from the project, its lock, and the adapter
registry. Per-ecosystem knowledge comes from the same `ProjectFormat` plugins
that maintain native project files
([ADR 0034](../../../docs/adr/0034-opm-projects-into-native-project-formats.md)),
so an ecosystem added to opm appears here without this document changing.

The manifest is canonical JSON (RFC 8785) and is digested like every other PREX
document, which is what makes it an artifact — publishable, pinnable, and later
verifiable as the same document — rather than a report.
