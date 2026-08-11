# ADR 0035: A PREX registry is a Registry Definition with an HTTP binding

- Status: Accepted
- Date: 2026-08-10
- Builds on [ADR 0032](0032-wit-adapters-and-registry-definition.md) and
  [ADR 0034](0034-opm-projects-into-native-project-formats.md)

## Context

ADR 0034 landed the [package manifest](../../spec/prex/v1/package-manifest.md):
one document naming a package and every ecosystem it ships to, modelled on the
MCP registry's `server.json`. Nothing served those documents. There was no wire
contract for asking a source what it has, no way for `opm` to consume a registry
someone else runs, and no way to stand one up.

The obvious move would have been to write a registry protocol from scratch. The
MCP registry did exactly that and it works — but it then has to document, in
prose, which of its endpoints are optional, and leave clients to probe.

PREX already had the missing half. A **Registry Definition** is a
capability-discoverable service index: it says which operations a source
supports, and an absent resource type means unsupported rather than unknown.

## Decision

A PREX registry **is** a Registry Definition, with the endpoints pinned down.

1. **Discovery is the entry point.** `GET /.well-known/prex-registry` returns
   the Registry Definition. Each resource type maps to one route
   ([registry-api.md](../../spec/prex/v1/registry-api.md)). Which endpoints
   exist is discoverable, not documented and hoped for. Nothing new was invented
   to make this work — four resource types were added to a vocabulary that
   already had eleven.

2. **The wire shapes follow MCP where MCP was right.** Cursor pagination with
   `nextCursor`, plus `updatedSince`, is a complete mirror protocol. There is no
   reason to differ and every reason not to: a subregistry someone already knows
   how to write against MCP should be a small port, not a rewrite.

3. **Registry assertions are kept out of the publisher's document.** MCP stamps
   `status`, `publishedAt` and `isLatest` into `_meta` inside the server
   document. PREX puts them in a sibling `registryMetadata` field. Merging them
   destroys the ability to say which party claimed what — and the publisher's
   document is the thing under signature, so mixing in a registry's assertions
   would mean either the signature covers claims the publisher never made, or it
   covers nothing.

4. **Published documents are signed, and the registry counter-signs.**
   `SignedPackageManifest` uses `SignedReceipt`'s construction exactly — ed25519
   over `formatDigest(manifestDigest)` — so one verifier serves both. Publisher
   and registry signatures carry distinct `role` values because they are
   distinct claims: "I wrote this" and "I accepted this".

   This is the capability MCP cannot offer. A mirror of an MCP registry has to
   trust the mirror; a mirror of a PREX registry can verify what it received.

5. **A signature and a namespace proof are independent.** A signature proves a
   document was not altered. It says nothing about who may use a name. A
   `NamespaceProof` binds a key to a reverse-DNS prefix by DNS TXT, an HTTPS
   well-known document, or explicit operator configuration — the last named
   honestly as a decision rather than a proof. Neither substitutes for the
   other: an unsigned document with a valid proof is unverifiable, and a signed
   document from a key with no claim to the name is a valid signature on a
   squatted name.

6. **A metadata-only registry is a complete registry.** The blob route is
   specified and reserved so clients can be written against it, but a source
   that does not advertise `prex.registry.artifact/1` does not serve bytes and
   its manifests point upstream. The MCP registry works this way and is useful.

## Consequences

`opm` consumes any conforming registry by registering one more adapter module —
there is no registry-shaped special case in core, because a registry is a source
and sources were already the abstraction.

Federation falls out of the same fact. The plug-in that lets `opm` reach npm is
what lets a _registry_ reach npm, so an operator can stand up one index over
sources they do not own without either side learning about the other.

Two rules exist because getting them wrong is silent. A registry MUST order sync
by a monotonic watermark rather than `updatedAt` alone, or two records written
in one clock tick let a page boundary drop one that a mirror will never ask for
again. And `deleted` entries stay retrievable by exact version, because a
consumer holding a lockfile needs to learn a version was withdrawn, and a `404`
tells it nothing.
