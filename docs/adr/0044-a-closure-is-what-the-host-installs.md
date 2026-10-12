# 44. A closure is what the host installs: evidence, objectives and a single-version lock

Date: 2026-10-11

## Status

Accepted.

Relates to: [0006](0006-resolution-semantics-profiles.md),
[0007](0007-loss-aware-ir.md),
[0033](0033-native-supply-chain-capture-and-mitigation.md),
[0034](0034-opm-projects-into-native-project-formats.md).

## Context

`opm add pkg:npm/vitest@4.1.9` against registry.npmjs.org, in a project written
by `opm init` with the policy it writes, did not work, and the two ways of
making it appear to work were both wrong.

- With the default policy it was refused twice: `NPM_ENGINE_RANGE_NATIVE_ONLY`
  (a semantic loss declared at `error` against a project cap of `warning`) and
  `supply-chain.release-age` ("publishedAt/evaluationTime not captured").
- With those two relaxed it succeeded and locked **one package**, vitest alone,
  although the guide says a lock records the proof-checked closure. The walk
  that produces the closure had been failing and the failure had been swallowed.

Taking the failures apart found seven independent causes, each hidden by the one
before it.

1. The solver was loaded only from the wasm build. A checkout that cannot build
   `wasm32` (no target, no `wasm-bindgen`) still builds the Node-API addon from
   the same crate, and nothing used it.
2. The solve asked for the optimizing objectives. The engine proves those only
   by exhaustive search and refuses them past 22 universe nodes ("objective
   optimality cannot be independently proven"), in practice with
   `RESOURCE_LIMIT` from about a dozen. A real closure is hundreds of nodes, so
   every real closure was refused. And for a small universe the engine compared
   Resolvo's answer with the exhaustive oracle even when the request named no
   optimum.
3. Five of vitest's dependencies (`@vitest/pretty-format`, `picomatch`,
   `std-env`, `tinyexec`, `fdir`) have a _development_ dependency written as
   `npm:react-is@18.3.1`, `github:user/repo`, `latest` or `npm:name@^6`. The npm
   adapter threw on them, so those versions could not be inspected, left the
   candidate set, and the solve for vitest was unsatisfiable.
4. Native packages ship as one optional dependency per platform. Optional
   dependencies were never followed, so a locked `vite` had no `rolldown`
   binding. The abbreviated packument also omits `libc`, so the glibc and musl
   builds of a binding were indistinguishable.
5. Every npm range except an exact version reached the solver as "any version of
   this package". The engine also ordered candidates by comparing
   `versionSortKey` (which the engine requires to equal the version) as a
   string: `4.0.9` above `4.0.10`, `0.30.9` above `0.30.21`.
6. Nothing captured a publish time. The abbreviated packument has none; the full
   one is 6.2 times larger for the closure of vitest (54 MB against 8.7 MB, and
   `vite` alone is 39 MB against 2.3 MB).
7. The adapter host builds a new provider for every request for one, and a
   provider revalidates what it holds on every use. Resolving vitest made 165
   requests for 42 distinct documents.

## Decision

1. **The walk follows what an install installs.** Runtime dependencies, required
   peers, and optional dependencies _where they run_. Platform is evaluated
   against what Node reports (`os`, `cpu`, `libc`), in npm's own vocabulary,
   because that is how the predicate is stored. An optional dependency that runs
   here is admitted and its edge made hard; one that does not is left out and
   never downloaded. A hard dependency that does not run here is refused, as npm
   refuses it. A specifier that is not a registry range (git, URL, alias,
   dist-tag) is never read as the registry's package of that name: in a field an
   install walks it fails by name, in a field it does not walk it is kept as an
   unconstrained requirement with an `info` loss.

2. **A closure solve asks for the hard constraints, at every size.** The lock
   claims that every requirement is satisfied and that the checker re-validated
   that. It does not claim the set is the smallest or the newest possible. The
   engine's oracle now runs only when the request asks for an optimum, and
   candidates are ordered newest first by the engine's own version comparison
   rather than by the sort-key string. (`versionSortKey` still has to equal the
   version; that is the engine's guard against a forged key and it is
   unchanged.)

3. **Ranges are enforced, and checked twice.** The npm requirement carries the
   comparison form of its range (`vers:npm/>=2.9.0|<3.0.0`). It is a superset
   (it admits a prerelease of the next version that npm's `^2.9.0` excludes) and
   is recorded as such, so after the solve every edge is checked against the
   native range by the ecosystem's own codec and a lock never pairs a package
   with a version it does not accept.

4. **A lock holds one version of a package.** The engine allows several (that is
   what PREX coexistence means), so when the solve leaves two, the walk
   withdraws every candidate of the package but the newest one that all selected
   requirements on it accept, and solves again. When no release suits all of
   them the resolve fails and names who requires what. It does not back out of a
   newer dependent to find an older one that would agree.

5. **Publish time is the cheapest evidence that settles the question, and the
   gate is not weakened where it cannot be reached.** In order: the packument's
   own `time` if the registry supplies it abbreviated; `modified` when it
   predates the cutoff (the registry last changed the document then, and
   publishing changes it, so no version is newer; no request at all, and
   reported as `publishedNoLaterThan`, never as `publishedAt`); the full
   packument's `time` for a package changed since the cutoff, once per package.
   `@openpacker/policy` accepts `publishedNoLaterThan` one-sidedly: it can clear
   a minimum age and can never fail one. The same evidence is captured for a
   dependency nobody named, and a release inside the window is passed over for
   the previous release in range (as pnpm does) rather than failing the install.
   deps.dev would be cheaper than the full packument (1.5 KB a version) but is a
   third party that would learn every package added, and the registry is the
   authority for its own publish times.

6. **`NPM_ENGINE_RANGE_NATIVE_ONLY` is information.** npm treats `engines` as
   advice (`EBADENGINE` is a warning unless `engine-strict`), the range is kept
   verbatim in `nativeSemantics.data.engines`, and nothing about which packages
   are selected or which bytes are installed depends on it. Declared as an error
   it denied every real package under the default policy, because nearly all of
   them state which Node they support. The policy's comparison
   (`severity > semantic_loss_maximum`) was correct and is unchanged; the
   classification was wrong. `NPM_PACKAGE_TARGET_PREDICATE_ARTIFACT_ONLY` stays
   an `error`: a package-level `os`/`cpu`/`libc` predicate really is expressed
   only at the artifact. It is recorded as met (a `warning`, with the host in
   its mitigation) only for a candidate whose predicate the walk evaluated for
   this host and found satisfied; where it could not be evaluated it stays an
   error and the default policy refuses it.

7. **A closure that cannot be computed is an error.** Failures no longer fall
   back to the direct set. Only what came from a registry is walked through that
   registry. The policy, digest and size refusals propagated before and still
   do.

8. **One provider per ecosystem per resolve**, over a transport that answers a
   repeated read of the same document from memory (never an artifact download),
   shares one request among concurrent reads of it, and takes every request
   through twelve slots.

9. **A level of the walk reads together and is applied in order.** The reads of
   all the items of one breadth-first level (their candidate lists and the
   inspection of their candidates) run concurrently; the results are then
   applied in queue order, so the graph, its package order and every diagnostic
   are those of a sequential walk and do not depend on which read finished
   first. The artifacts of the selected packages are fetched together and taken
   in solve order for the same reason.

## Consequences

Measured against registry.npmjs.org on 2026-10-11 (Node 22.22.0, linux/x64,
glibc), project written by `opm init` with `ecosystems = ["npm"]` and the policy
it writes:

|                                                     | before                                    | after                                                                                           |
| --------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `opm add pkg:npm/vitest@4.1.9`                      | refused                                   | exit 0                                                                                          |
| packages locked                                     | 1 (with the gates off)                    | 44, each with a sha256 digest                                                                   |
| same set as npm's own resolver (`@npmcli/arborist`) | no                                        | yes, 44 of 44 at the same versions                                                              |
| requests                                            | 165 for 42 distinct documents (walk only) | 160, none repeated: 69 packuments, 47 version documents for `libc`, 44 tarballs                 |
| wall time                                           | n/a                                       | 13 to 14 s (21 s while the walk read one document at a time, 13 of them waiting on the network) |

The 44 are the 42 non-optional packages npm resolves plus the host's
`lightningcss-linux-x64-gnu` and `@rolldown/binding-linux-x64-gnu`; the other 25
optional platform packages are not downloaded. Not one of the 44 packages needed
the full packument: the freshest, `tinybench`, had last changed 24.8 hours
earlier.

Limits, stated rather than hidden.

- **The lock is host-specific.** It holds the optional dependencies that run on
  the machine that resolved it, as the PyPI marker evaluation already did. A
  lock made on linux/x64 has no darwin binding. A portable lock would record
  every optional platform package with its predicate, and install the matching
  one.
- **A lock cannot hold two versions of one package.** Its entries are keyed by
  package name. npm and pnpm nest. `opm add tinybench` after `vitest@4.1.9`
  (which needs `tinybench@^2.9.0`) pins `tinybench@6.2.2` directly, and the
  resolve fails naming both requirements. While ranges were not yet enforced the
  same command silently succeeded and pointed vitest at 6.2.2, which is why the
  check exists. No package in the closure of vitest@4.1.9 needs two versions
  (npm's own tree for it has none). Proposal, not done here: key lock entries by
  exact purl, with `dependencies` naming exact purls and the layout nesting
  them; and a single-version request flag for the engine so Resolvo backtracks
  to an older dependent (it has `allow_multiple` on for every candidate set)
  instead of the walk reporting the conflict.
- Lock content is not optimal. Within a range the newest is preferred; npm's
  `pick-manifest` additionally prefers `latest` if it satisfies and avoids
  deprecated versions, which this does not.
- A runtime dependency written as git, URL, alias or dist-tag is refused.
- A packument over 64 MiB (the full one, 96 MiB) is refused by the adapter's
  bound. It was 8 MiB, which refused `typescript`; see the amendment below.
- The `os`/`cpu`/`libc` predicate is evaluated for npm only.

## Amendment, 2026-10-12: the packument bound

`opm add pkg:npm/typescript@5.9.3` exited 8 with
`opm: Response exceeds 8388608 bytes`. The abbreviated packument lists every
version ever published, and typescript publishes nightlies: 3,850 versions,
8,728,082 bytes. A package manager that cannot add typescript cannot replace
npm. Lifting the 8 MiB showed a second bound behind it, and a third behind that.

### What the registry serves

Measured against registry.npmjs.org on 2026-10-12, decoded, over about 50
packages chosen for their number of versions. The registry answers with
`content-encoding: br` and no `Content-Length`; the wire size is a fifth of
these.

| package         | abbreviated | values  | versions | full       | values (full) |
| --------------- | ----------- | ------- | -------- | ---------- | ------------- |
| next            | 25,636,598  | 846,076 | 3,986    | 31,405,652 |               |
| gatsby          | 15,734,819  | 512,428 | 2,995    | 23,623,202 |               |
| @ionic/core     | 10,128,386  | 255,914 | 4,942    | 27,340,880 |               |
| firebase        | 9,876,235   | 184,635 | 4,224    | 30,429,747 |               |
| typescript      | 8,728,082   | 260,520 | 3,850    | 15,783,773 | 538,245       |
| playwright-core | 8,418,576   | 156,979 | 5,714    | 18,551,593 |               |
| vite            | 2,333,244   | 79,105  | 760      | 38,988,699 | 128,822       |

All six of the first rows are over 8 MiB. A document costs 27 to 54 bytes a
value and is 6 levels deep.

### Three bounds, not one

1. **Bytes.** The adapter asked the transport for at most 8 MiB.
2. **Parsed values.** `json()` refused any document of more than 200,000 values,
   after reading it. `typescript` is 260,520; `next` is 846,076. The full
   packument, read for publish times (decision 5), is 538,245 values for
   `typescript`, and its failure was swallowed, so under the default policy the
   add would still have failed, now with
   `publishedAt/evaluationTime not captured for minimum release age`, whenever
   `typescript` had been modified within the release window: it published on 55
   of the last 60 days.
3. **The resolve's memory.** `MemoizingTransport` kept a document only if the
   request asked for at most 8 MiB. Lifting the adapter's bound alone left every
   large packument unkept, so the walk fetched it again at each use (a fixture
   registry served a packument the size of `typescript`'s eight times, the
   165-for-42 of decision 8 returning for the biggest documents).

### Decision

- **The abbreviated packument is bounded at 64 MiB**, `MAXIMUM_PACKUMENT_BYTES`
  (`MAXIMUM_METADATA_BYTES` in `@openpacker/adapter-core`, shared so the
  transport and the adapter cannot drift apart). It is 2.6 times `next`, the
  largest measured, and 7.3 times `typescript`. `next` published 580 versions in
  the year to 2026-10-12 at 6.4 KB each, 3.6 MiB a year, so the bound has about
  a decade of room and still means something: a registry that sends more is not
  serving a packument. It is also below the 128 MiB an artifact may weigh, so
  the bytes a hostile registry can make the client hold for a packument are no
  more than for a tarball. What parsing them can cost is a separate bound, and
  not that one: see "The value limit is a budget the parser stops at". 32 MiB
  (1.25 times `next`) was rejected as a fit to today that `next` outgrows; 128
  MiB as double the envelope with nothing measured that needs it.
- **A parsed document may hold one value per 16 bytes of its byte bound**
  (`metadataValueLimit`): 4,194,304 for the abbreviated packument, 6,291,456 for
  the full one (96 MiB, unchanged: the largest full packument measured is
  `vite`, 39 MB). The count is derived rather than chosen so that it cannot fall
  behind the bytes again, and it is above any real document (five times `next`)
  and below what a body of `[1,1,1]` would make (two bytes a value). Other
  documents keep the 200,000 default. The parser enforces it as it builds the
  tree and refuses the first value past the limit; it never counts a finished
  tree.
- **The bound is enforced while the body arrives.** A `Content-Length` over the
  limit is refused without reading the body; otherwise chunks are counted as
  they come and the read is cancelled on the chunk that crosses the limit. A
  missing length, or one smaller than the body, therefore still bounds what is
  held. The header counts wire bytes, so for a compressed response it
  understates what decoding makes; the count that matters is the decoded one and
  that is the one taken. This was already how the transport worked; it is now
  pinned by tests (an endless body with no length, a body longer than its
  announced length, a declared length over the limit, a body of exactly the
  limit and of one byte more).
- **A refusal names what was being read and what was seen.**
  `The packument of @scope/name is 67108865 bytes (64.00 MiB) and exceeds the limit of 67108864 bytes (64.00 MiB)`,
  or, for a body streamed to the point it went over,
  `... exceeds the limit of ...: stopped reading at N bytes`. The number is
  where the read stopped, and is said to be, not the size of the response. The
  code is still `UPSTREAM_RESPONSE_TOO_LARGE`.
- **The resolve keeps what an adapter may ask for.** `MemoizingTransport`'s
  per-document limit is `MAXIMUM_METADATA_BYTES` and its total four of those
  (256 MiB). What it keeps is what the provider holds for the resolve anyway
  (the same buffer), so this changes how much can be answered from memory and
  not how much is held.

- **A document the client refuses is the reason there is no publish time.**
  `fetchFullTimes` swallowed every failure of the full packument, which is what
  hid the 538,245-value problem: "not captured" is as true of a registry that is
  down as of a document that was too large. A refusal of the document (too many
  bytes, too many values, too deep, not JSON) now surfaces from `publishTime`,
  named by package and document, and `capturePublishTime` keeps it on the facts
  as `publishTimeUnavailable`; the release-age check appends it:
  `publishedAt/evaluationTime not captured for minimum release age: The full packument of typescript is 100663297 bytes (96.00 MiB) and exceeds the limit of 100663296 bytes (96.00 MiB)`.
  A registry that is down, or answers with an error status, leaves the message
  as it was.

### The value limit is a budget the parser stops at

The first version of this amendment counted values after `json()` had built the
tree, and said that a hostile registry was allowed no more of the client's
memory by a packument than by a tarball, with a worst case of 1.5 GiB. Both were
wrong, and an independent review measured it. The byte bound lets a body of 64
MiB through, and a body that dense holds millions of values for its size: `{},`
is three bytes and an object. Counted after the parse, the refusal came only
after every value was built.

One `json()` call on a body of exactly 64 MiB (Node 22.22.0, linux/x64; seconds
are from a machine whose load average was 14 to 25 on 4 CPUs, so they are an
upper bound and the memory is the figure to read):

| body                                  | counted after the parse | the parser stops at the limit   | read before it stopped |
| ------------------------------------- | ----------------------- | ------------------------------- | ---------------------- |
| `{},` times 22.4 million (67,108,864) | 50.7 s, 7,442 MB RSS    | 2.0 to 4.4 s, 1,108 to 1,121 MB | 12.6 MB                |
| `1,` times 33.6 million (67,108,863)  | 13.7 s, 2,556 MB RSS    | 0.7 to 1.1 s, 391 to 393 MB     | 8.4 MB                 |

The parser now counts: `parseCanonicalJson` takes `maximumValues` and
`maximumDepth` and refuses the first value past either before it is built, so
the work is set by the limit and not by the body. The alternative, a pre-scan of
the text for structural characters before building anything, refuses with no
tree at all, but it is a second pass over every document including the
legitimate ones, it needs its own copy of the string and escape grammar, and
without tracking which container each comma belongs to it counts every object
member twice, so it would not be the count the tree is made of. The refusal is a
`MetadataLimitError` carrying `visited` (the limit plus the value it refused),
`offset` and `documentLength`, which is what the tests assert rather than a
time. Parsing a legitimate 25.6 MB packument costs the same as before (about 1.5
s either way).

What this leaves is a constant, and it is not small. A tree of 4,194,304 values
costs about a gigabyte, because an empty object costs about 260 bytes of heap
for three bytes of body. The heaviest accepted shape tried, 64 MiB of
`{"aaaaaaaaaaaaaaaaaaaaaaaaaa":1},` (4.07 million values, under the limit), was
parsed whole in 9.5 s (loaded machine) and 1,218 MB. These figures do not grow
with the registry's body, because the byte bound refuses a larger one first. The
refused case is equal to what the original 8 MiB bound let a body of `{},` cost
(4.4 s, 1.1 GB, measured in the review), and no longer six times worse.

The lever is the 16 bytes a value. 32 would halve the worst case and still allow
2.5 times the values of `next`, but the two bounds would then disagree for a
real document: one of the densest real shape (27 bytes a value) would be refused
for its values at about 54 MiB, before the byte bound. Which trade to make is
left to a person, and nothing here changes it.

### Not done: reading only what the walk needs

Parsing less of a packument was considered and not done. The walk picks a
version by range, so any version may be inspected; it needs the version list,
the dependency fields and `dist` of nearly all of them, and the abbreviated
document has already dropped everything else. The provider also keeps the body
it read, which is what the record's evidence refers to. A projection would save
memory that is not the constraint (below), at the cost of a second parser on the
path every locked package takes.

### Memory

A hostile registry can have a resolve hold up to twelve bodies at once (the
transport's slots), each up to 64 MiB, and up to twice that for the instant the
chunks are joined: 0.75 GiB steady, 1.5 GiB at worst. That is bytes, and an
artifact download has the same shape at 128 MiB.

Parsing is the other part, and is measured in the previous section: the tree of
one document is at most about 1.1 to 1.2 GB (the densest refused body and the
heaviest accepted one), and the parse is on the main thread, so there is one
tree at a time. The two parts add to about 2 GB, 2.7 GB while a body is being
joined. That is an estimate from the two measured parts, not a measurement of
both together, and it is a constant of the limits and not of the registry: a
larger body is refused on bytes before it is parsed.

Measured on Node 22.22.0, linux/x64, live registry, in a project written by
`opm init` with its default policy:

|                                             | requests | wire bytes | wall   | peak RSS |
| ------------------------------------------- | -------- | ---------- | ------ | -------- |
| `opm add pkg:npm/typescript@5.9.3`          | 3        | 8,041,336  | 4.7 s  | 367 MB   |
| `opm sync` (`native_projection = "layout"`) | 3        | 8,043,278  | 4.7 s  | 362 MB   |
| `opm add pkg:npm/@types/node`               | 4        | 1,632,949  | 2.5 s  | 167 MB   |
| `opm add pkg:npm/vitest@4.1.9`              | 160      | 17,342,455 | 13.8 s | 433 MB   |
| `opm resolve pkg:npm/next`                  | 108      | 14,570,411 | 22.5 s | 958 MB   |
| the same with `--max-old-space-size=256`    | 108      | 14,569,442 | 34.2 s | 458 MB   |

Wire bytes are as received, compressed, tarballs included. The three requests
for `typescript` are its abbreviated packument, its full packument (for the
publish time of a package modified within the last day) and the tarball.
`vitest` is the 160 requests, none repeated, of the table above. The resolve of
`next` holds a 25.6 MB packument and finishes inside a 256 MB old-space limit,
so the 958 MB is the collector's slack and not live data.

### Limits

- The other ecosystems' metadata bounds (cargo, PyPI, NuGet, Go, Maven: 8 MiB
  each) were not measured against their registries here.
- The value limit allows a tree of about a gigabyte by design (above). A tighter
  limit is a change to `MINIMUM_BYTES_PER_METADATA_VALUE`, and to the tests that
  pin 4,194,304, and was not made here.
- The at-scale test refuses a 64 MiB body at the abbreviated limit. The full
  packument's limit (6,291,456 values at 96 MiB) goes through the same code and
  is exercised at small limits and by depth, not with a 96 MiB hostile body.
- Parsing is the cost of a large document: the canonical parser reads 12 to 16
  MB a second, `next`'s packument takes 1.6 s, and the resolve of `next` is
  CPU-bound at 22 s.
- Revisit the bound when any real abbreviated packument passes 32 MiB, half of
  it.
