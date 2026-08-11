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

1. **Validate the request against `RegistryPublishRequest` and refuse what does
   not conform, storing nothing.** A registry is the last party that can cheaply
   refuse a document it cannot honour. Everything downstream — a mirror, a
   resolver, an install — meets it with no way to say no, so a document stored
   here becomes every consumer's problem. The reported error SHOULD name the
   failing instance path, because a publisher fixes these one at a time.
2. Re-derive the manifest digest from canonical bytes and compare it to
   `manifestDigest`. A caller-supplied digest is never taken on trust.
3. Verify every signature over `formatDigest(manifestDigest)` — the same
   construction `SignedReceipt` uses, so one verifier serves both.
4. Establish that a signing key may publish under this name (below).
5. Reject a re-publish of an existing `(name, version)` whose digest differs.
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

## Reading a document you can parse

Validating on publish stops a registry storing something no client can read. It
does nothing for the client that meets a document published under **last
year's** schema — which is the failure MCP shipped: entries carry whatever
version they were published under, and a consumer that cannot deserialise one
simply fails. The cost lands at install time, on the party least able to do
anything about it.

A client states what it can read:

```http
Accept: application/vnd.prex.manifest.v1+json
```

and the registry either serves that version — migrating the stored document
through a registered chain, shortest route first, since every hop is a chance to
lose something — or answers **`406`** naming what the document is and what it
could be served as. `406` is a better answer than a document the client will
mis-parse, because a mis-parse is silent.

An absent `Accept`, `*/*`, or plain `application/json` means **no preference**,
not "nothing is acceptable"; those get the stored version. The response's
`Content-Type` names the version served, so a client that negotiated one does
not have to read the body to learn what it got. A `q=0` is a refusal, and is
honoured as one.

## Search

Search MUST NOT be the only thing a registry is slow at. `LIKE '%term%'` cannot
use an index — every search is a full scan, and that is the shape behind the MCP
registry's 20–25 second reads.

There is exactly **one** index, and it is derived from the stored entries rather
than maintained beside them. A search index kept as a second copy of the corpus
is a second copy that can disagree with the first, and a registry whose search
and reads disagree has two answers to the same question. A rename, a withdrawal,
or a rebuild after an import must not be able to produce a divergence, because
there is nothing to diverge.

A registry that cannot build an index MUST still serve search, and MUST report
which it used in `metadata.searchMode` (`indexed` or `scan`). One quietly
falling back to a full scan is indistinguishable from one that is fast until it
is not.

Query text is treated as **terms, not syntax**. A search box that passes `NOT`,
`*` or an unbalanced quote through to a query language turns some searches into
errors and others into queries the user did not write.

## Holders, quotas, and moving a name

A namespace proof binds a _key_ to a name prefix. That is the wrong unit for two
questions a registry has to answer, and getting the unit wrong is why both have
gone unanswered elsewhere.

A survey of the MCP registry found a single domain behind **75 namespaces**, 62
of which served a marketing page rather than a server. Nothing was hidden; the
data simply only ever existed as a scatter of individual proofs, so seeing the
pattern took a research project. So a proof is attributed to a **holder** — the
DNS name, the forge account, or the operator decision it actually rests on — and

```http
GET /v1/holders
GET /v1/holders/{holderId}
```

make that a lookup. Holders are listed most-namespaces-first, because a list
sorted by name buries what the route is for. Each namespace carries a package
count: 75 namespaces holding one package each is a different thing from 75
holding none.

A holder's authority stops where its proof does. `io.github.acme` rests on the
account, not on the forge — collapsing it to `github` would let one account
speak for every other.

### Quotas

Publishing is charged **per holder, never per namespace**. A per-namespace
budget is not a budget: the way around it is to take out another namespace,
which costs one DNS record and is precisely the behaviour the holder identity
exists to make visible. Over the allowance, a registry MUST answer `429` with
`Retry-After` set to when the oldest publish in the window ages out — the only
moment the answer changes. A client sent back earlier is refused twice, and a
client refused twice retries harder.

The window slides. A fixed bucket lets a publisher spend a full allowance at
`:59` and another at `:00`, which is twice the limit at the moment it matters.

A registry MUST NOT charge a publish it refused; otherwise exhausting a rival's
allowance is as cheap as publishing rubbish under their name and being told no.
A retried publish of identical bytes is idempotent and is charged once.

### Rename and transfer

```http
POST /v1/packages/{name}/rename
GET  /v1/packages/{name}/redirect
```

A publisher moving from a forge namespace to their own domain should not have to
ask a maintainer, and everything pinned to the old name should keep resolving.
The request body is a `SignedPackageRedirect`, and the registry MUST refuse it
unless one signing key is permitted to publish **both** names. A key holding
only the source could redirect its users to somebody else's package; a key
holding only the destination could claim any package it liked.

The move is a **document**, not an HTTP 308. A mirror sees only bytes, and a
redirect it cannot verify is a redirect it has to trust. `reason` distinguishes
a `rename` (same holder) from a `transfer` (a new one), because who holds a
package afterwards is a fact consumers may have policy about.

Reads at the old name resolve through the chain and MUST say so — an
`x-openpacker-renamed-from` header and `redirectedFrom` in the response. A
client that silently receives a different package than it asked for has no way
to notice. Chains are bounded and cycle-guarded: a loop is refused rather than
followed. Publishing at a name that has moved is refused with `409`, because the
redirect told everyone otherwise and two live copies of a package is how a
lockfile stops meaning one thing.

**Typosquatting is deliberately out of scope.** Names here are
namespace-qualified and a namespace needs a proof, so the cheap attack is not
one name a character away from a popular one — it is many namespaces, which is
what holders make visible.

## Key lifecycle

Signing without revocation is a hole that signing creates. Before signatures, a
compromised publisher was something a registry could fix by deleting their
entries. Once consumers verify offline, deletion is not enough: a mirror still
holds a document that still verifies against a key the attacker still controls.

```http
GET /v1/revocations
```

Returns a `SignedRevocationList`. **It MUST be signed** — a revocation a client
cannot verify is a rumour, and an attacker who can forge or strip one has undone
the signing scheme. A registry MUST serve the list even when empty, so a client
can tell "this registry revokes nothing" from "this registry does not do
revocation"; the second is a reason to trust it less.

`serial` is monotonic. A client that has seen a higher serial MUST refuse a
lower one, or a replay pins it to the state of the world from before a
compromise. A client MUST NOT cache the list indefinitely, for the same reason:
one that never re-reads never learns.

### Two effects, and why both exist

- **`from-now`** — signatures made before `revokedAt` stay valid; the key can no
  longer publish. This is a routine retirement.
- **`retroactive`** — every signature that key ever made is disowned. This is a
  theft.

Collapsing them into one forces an operator to choose between an unusable
registry and an unrevoked compromise, and they will choose not to revoke. A
client MUST report a revoked-but-otherwise-valid signature **distinctly from a
forged one**: "this is not a real signature" and "this was real and the key has
since been withdrawn" are different facts about a package, and a consumer's
policy may accept one and not the other.

### Rotation

```http
POST /v1/keys/rotations
```

A `KeyRotation` is a new key attested by its predecessor, signed over the
canonical digest of the document with `signature` removed. The registry MUST
verify that attestation — otherwise anyone can nominate a successor to somebody
else's key — and SHOULD then record a `from-now` revocation of the old key.

Continuity is the point. Without it, rotating a key means re-signing every
version you ever published, which is why people do not rotate.

## Serviceability

A registry entry is a claim. The MCP registry was measured with **11.2% of
advertised endpoints not speaking MCP at the URL given** — roughly 1,177 URLs
where a client follows the registry and reaches something else. Not dead hosts:
live hosts serving a page where the server used to be. Nobody had re-checked.

A registry SHOULD therefore re-verify what its manifests advertise, and MAY
report the result as `registryMetadata.serviceability`.

**Checks SHOULD be driven by reads rather than by a schedule.** A sweep spends
the same egress on every entry whether or not anyone wants it; requests are a
better sampler, because the packages people resolve are the ones whose rot
matters and the long tail costs nothing until someone asks. A read MUST NOT
block on the check — a registry whose latency is a function of every publisher's
uptime has made someone else's outage its own.

Three classifications, and two of them are where implementations go wrong:

- **`gated` is healthy.** 26.5% of the endpoints in that survey answer
  401/402/403 because they are commercial services wanting a token. An
  implementation that reads non-200 as failure condemns a quarter of a registry.
  The surveyor's own false positive was a **402 Payment Required** — enumerating
  the auth statuses from memory rather than from the spec cost them a wrong
  answer.
- **A timeout or 5xx MUST stay `unchecked`.** It is evidence about the network
  between the registry and the origin. Recording it as failure exports the
  registry's weather as a fact about somebody else's software.
- **`unreachable` needs a definite answer** — a 404, a 410, or bytes that
  contradict the manifest.

`method` states what was actually done, because "something answered" and "these
are the right bytes" are different claims and a consumer's policy may need the
stronger one.

### Consumer observations

`POST /v1/packages/{name}/versions/{version}/observations` lets a consumer
report that something did not work. A registry MUST treat this as
**corroboration only**: it MAY bring the next first-party check forward, and
MUST NOT let it set state. A registry that let anonymous reports mark a package
unreachable would be offering "report a competitor" as a feature.

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
