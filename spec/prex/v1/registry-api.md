# PREX registry API

The HTTP binding for a package source that serves
[package manifests](package-manifest.md). Schema:
[`schemas/registry-api.schema.json`](schemas/registry-api.schema.json).

## A registry is a Registry Definition with a binding

This is not a new concept beside [Registry Definition](registry-definition.md) —
it **is** one, with the endpoints pinned down. A PREX registry serves its own
service index, and a client enables only the operations that index advertises.
Which endpoints exist is therefore **discoverable**, not described in prose and
hoped for.

That is the difference from the
[MCP registry's generic contract](https://github.com/modelcontextprotocol/registry),
which this otherwise follows closely: MCP documents which endpoints are optional
and leaves a client to probe. PREX already had the discovery document, so the
binding just says which resource type maps to which route.

| Resource type                        | Route                                           |
| ------------------------------------ | ----------------------------------------------- |
| —                                    | `GET /.well-known/prex-registry` — the index    |
| `prex.registry.search/1`             | `GET /v1/packages?search=`                      |
| `prex.registry.enumerate-versions/1` | `GET /v1/packages/{name}/versions`              |
| `prex.registry.package-manifest/1`   | `GET /v1/packages/{name}/versions/{version}`    |
| `prex.registry.sync/1`               | `GET /v1/packages?updatedSince=`                |
| `prex.registry.publish/1`            | `POST /v1/publish`                              |
| `prex.registry.artifact/1`           | `GET /v1/blobs/{algorithm}/{value}` — see below |

A route whose resource type is absent MUST return `404` with a
[problem document](errors.md). Absent means unsupported, the same rule as
everywhere else in PREX.

## Discovery

```http
GET /.well-known/prex-registry
```

Returns a `RegistryDefinition`. A client reads `purlTypes` to learn what the
registry serves and `resources` to learn what it can be asked. `registryId` is
what a policy pins — relocating a mirror may keep the id when content authority
is unchanged; changing authority MUST change it.

## Listing, search, and sync

```http
GET /v1/packages?search=&purlType=&updatedSince=&limit=&cursor=
```

Returns a `PackagePage`: `packages[]` of `RegistryEntry`, and `metadata` with
`count` and `nextCursor`. `nextCursor` absent or null means the last page.

- `search` — case-insensitive substring over package names. Deliberately simple;
  anything richer belongs in a subregistry built on `updatedSince`, which is the
  MCP registry's own position and the right one.
- `updatedSince` — RFC 3339. Together with `cursor` this is a complete mirror
  protocol.

**A registry MUST order by a monotonic watermark, not by `updatedAt` alone.**
Two records written in the same clock tick, or a clock that steps backwards,
otherwise let a page boundary drop a record that a mirror will never ask for
again. An opaque cursor exists so a registry can carry the tiebreak without a
client knowing about it.

A client MUST NOT treat an empty page as the end of the walk while `nextCursor`
is present; a federating registry may legitimately return an empty page while a
slow source is still being queried.

## One package version

```http
GET /v1/packages/{name}/versions/{version}
```

`version` accepts the literal `latest`, resolving to the entry whose
`registryMetadata.isLatest` is true. `deleted` entries are excluded from
listings by default and MUST still be retrievable by exact version — a consumer
holding a lockfile needs to learn that a version was withdrawn, and a `404`
tells it nothing.

## What the registry asserts, kept separate

`RegistryEntry` has the publisher's `manifest` and the registry's
`registryMetadata` — `status`, `publishedAt`, `isLatest`, `registryId`, and
`sourceId` when the entry is being relayed rather than held.

MCP stamps the equivalent into `_meta` inside the server document. PREX keeps
them in separate fields, because merging a registry's assertions into a
publisher's document destroys the ability to say which party claimed what — and
the publisher's document is the thing under signature.

## Publishing

```http
POST /v1/publish
```

A `RegistryPublishRequest` carries the manifest, its digest, at least one
signature, and optionally a namespace proof. The registry MUST:

1. Re-derive the manifest digest from canonical bytes and compare it to
   `manifestDigest`. A caller-supplied digest is never taken on trust.
2. Verify every signature over `formatDigest(manifestDigest)` — the same
   construction `SignedReceipt` uses, so one verifier serves both.
3. Establish that a signing key may publish under this name (below).
4. Reject a re-publish of an existing `(name, version)` whose digest differs.
   Immutability is what makes a lockfile mean anything.

The registry then counter-signs with `role: "registry"` and stores. Publisher
and registry signatures are distinguishable because they are different claims:
one says "I wrote this", the other says "I accepted this".

### Namespace proof

A signature proves a document was not altered. It says nothing about who may use
a name. `NamespaceProof` binds a key to a reverse-DNS prefix by one of:

- `dns-txt` — a TXT record at `_prex.<namespace-as-domain>` containing the key
  id.
- `https-well-known` — `GET https://<domain>/.well-known/prex-namespace` listing
  authorised key ids.
- `registry-configured` — the operator configured the binding out of band.
  Honest about being an operator decision rather than a proof.

The two mechanisms are independent and neither substitutes for the other: an
unsigned document with a valid namespace proof is unverifiable, and a signed
document from a key with no claim to the name is a valid signature on a squatted
name.

## Artifact bytes

`GET /v1/blobs/{algorithm}/{value}` is specified so the route is reserved and
clients can be written against it. **A registry that does not advertise
`prex.registry.artifact/1` does not serve bytes**, and its manifests'
`locations` point upstream instead. A metadata-only registry is a complete and
useful registry; the MCP registry is one.

## Federation

A registry MAY serve packages it does not hold, fronting upstream sources — an
ecosystem registry through an adapter, or another PREX registry through this
same binding. No new mechanism is involved: the plug-in that lets a client reach
npm is what lets a registry reach npm.

Three rules make a relayed answer honest:

1. **A relayed entry carries `registryMetadata.sourceId`.** The `registryId` is
   the registry that answered — it did answer — but `sourceId` records who
   actually holds it. A consumer can always tell what a registry holds from what
   it is passing along.
2. **Upstream signatures pass through untouched.** A relay MUST NOT re-sign an
   upstream's manifest as its own. Re-signing makes a relay indistinguishable
   from an original, and the upstream's key is the one a consumer wants to
   check. A relay MAY add its own signature alongside.
3. **Local wins.** A package the registry itself publishes MUST take precedence
   over any upstream of the same name, or an upstream that starts publishing a
   name you already publish silently takes it over.

A registry that queries an upstream and does not get an answer MUST distinguish
"nothing matched" from "a source did not respond", by naming unreachable sources
in the page metadata. A mirror that reads an outage as an empty result will
conclude it has caught up.

Sync (`updatedSince`) applies to what the registry holds, not to what it relays:
an upstream's changes are the upstream's to replay, and a mirror should follow
the source rather than a chain of relays.

## Errors

Problem documents per [errors.md](errors.md), with `code` drawn from the
normative `ErrorCode` vocabulary. A registry MUST NOT invent codes — a client
switching on `code` is the point of having one.
