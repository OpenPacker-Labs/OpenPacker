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

Measured against registry.npmjs.org on 2026-10-12, decoded. The registry answers
with `content-encoding: br` and no `Content-Length`; the wire size is a fifth of
these. This first table is the first look, about 50 packages chosen for their
number of versions. A wider look follows it and found larger documents; the
decisions below rest on that one.

| package         | abbreviated | values  | versions | full       | values (full) |
| --------------- | ----------- | ------- | -------- | ---------- | ------------- |
| next            | 25,636,598  | 846,076 | 3,986    | 31,405,652 |               |
| gatsby          | 15,734,819  | 512,428 | 2,995    | 23,623,202 |               |
| @ionic/core     | 10,128,386  | 255,914 | 4,942    | 27,340,880 |               |
| firebase        | 9,876,235   | 184,635 | 4,224    | 30,429,747 |               |
| typescript      | 8,728,082   | 260,520 | 3,850    | 15,783,773 | 538,245       |
| playwright-core | 8,418,576   | 156,979 | 5,714    | 18,551,593 |               |
| vite            | 2,333,244   | 79,105  | 760      | 38,988,699 | 128,822       |

All six of the first rows are over 8 MiB. In this look a document costs 27 to 54
bytes a value and is 6 levels deep.

#### The largest found

The wider look, the same day: 4,889 package names, which are the first 250
popularity-ranked results of each of 38 searches (react, typescript, aws, types,
babel and so on) and about 150 names chosen because they are heavy; 4,887
answered. The abbreviated packument of each was measured, and the full packument
of the 400 with the largest abbreviated one. It is a sample of what people ask
for and not of the registry's millions of packages, and it can miss a package,
and did: `renovate` (35,436,733 bytes abbreviated and 71,910,010 full, 5,693
versions) was not among the 4,889 names, and a second look found it. It can also
miss a package whose full document is far larger than its abbreviated one, as
`@material/list`'s is (3.05 MiB and 58.77 MiB), if its abbreviated one does not
rank in the first 400. The second look, made after an independent review, took
79 more names chosen for weight and 6,516 from 54 further searches (the
abbreviated packument of each, the full one of the 150 largest abbreviated), and
beyond `renovate` it found nothing past 22.1 MiB abbreviated (`prisma`) or 47.9
MiB full (`sanity`). Sizes are MiB, decoded; values are counted where they were
counted.

| package                      | abbreviated | values    | full  | values (full) | versions | published in the last 365 days |
| ---------------------------- | ----------- | --------- | ----- | ------------- | -------- | ------------------------------ |
| public-unscoped-test-package | 36.56       | 386,921   | 59.19 | 1,278,401     | 28,041   | 285                            |
| @prisma/client               | 36.41       | 1,077,961 | 65.35 | 2,127,695     | 10,660   | 525                            |
| renovate                     | 33.80       |           | 68.58 |               | 5,693    | 1,693                          |
| @bike4mind/cli               | 26.58       |           | 51.48 |               | 7,308    | 7,308                          |
| @wix/wix-code-types          | 25.94       | 831,901   | 72.96 | 2,655,900     | 15,118   | 71                             |
| next                         | 24.45       | 846,076   | 29.95 | 1,070,316     | 3,986    | 580                            |
| prisma                       | 22.13       |           | 41.94 |               | 9,365    | 619                            |
| @material/list               | 3.05        | 42,329    | 58.77 | 189,762       | 1,698    | 0                              |
| typescript                   | 8.33        |           | 15.06 |               | 3,851    | 260                            |
| vite                         | 2.23        |           | 37.18 |               | 760      | 83                             |

Three abbreviated documents are past 32 MiB (`public-unscoped-test-package`,
`@prisma/client` and `renovate`) and three full ones past 64 MiB
(`@wix/wix-code-types`, `renovate` and `@prisma/client`). The densest real
document found holds a value per 28.8 bytes (`@wix/wix-code-types`, full); the
others are 29 to 35 bytes a value, and the odd ones far sparser.

How much room that leaves is a straight line from last year, not a forecast: the
versions published in the last 365 days, each counted at the size of its own
entry in that document, taken as a year's growth.

| package             | grows a year, abbreviated / full (MiB) | years until 64 MiB / until 96 MiB |
| ------------------- | -------------------------------------- | --------------------------------- |
| next                | 3.37 / 4.19                            | 11.7 / 15.8                       |
| @prisma/client      | 2.20 / 4.42                            | 12.6 / 6.9                        |
| @wix/wix-code-types | 0.11 / 0.35                            | 351 / 66.7                        |
| typescript          | 0.42 / 0.95                            | 133 / 85                          |
| @bike4mind/cli      | 25.9 / 50.2                            | 1.4 / 0.9                         |
| renovate            | 10.29 / 20.85                          | 2.9 / 1.3                         |

`@bike4mind/cli` published all 7,308 of its versions in the last year, the
latest four hours before it was measured. A package that publishes a version for
every change outgrows any bound that means something, and nothing here is a
promise for it.

`renovate` was added after the rest and computed the same way, from the live
document on 2026-10-12: 33.80 MiB abbreviated growing 10.29 MiB a year is (64 -
33.80) / 10.29 = 2.9 years from 64 MiB, and 68.58 MiB full growing 20.85 MiB a
year is (96 - 68.58) / 20.85 = 1.3 years from 96 MiB. It published 1,693
versions in the last year, 1,692 of them still listed in the document. An
independent review got the same two figures.

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
  transport and the adapter cannot drift apart). The largest abbreviated
  document found is 36.56 MiB (`public-unscoped-test-package`; `@prisma/client`,
  which people install, is 36.41 MiB), so the bound is 1.75 times that, 2.6
  times `next` and 7.7 times `typescript`. At last year's pace there are about
  twelve years of room for `next` (11.7) and `@prisma/client` (12.6) and over a
  century for `typescript`, and for a package that publishes a version for every
  change or nearly so, three years or less: `renovate`, 2.9 years to the
  abbreviated bound and 1.3 to the full one, and `@bike4mind/cli`, 1.4 and 0.9
  (above). The revisit trigger this amendment first wrote, a real document past
  32 MiB, has been reached by three documents. The bound is not raised: every
  byte of it can be a hostile document's parse cost (see "What one hostile
  document costs") and nothing found needs more. It is below the 128 MiB an
  artifact may weigh, so the bytes a hostile registry can make the client hold
  for one packument are no more than for one tarball. That does not bound what
  parsing them costs, or what a resolve keeps: see "Memory". 32 MiB was rejected
  as below the largest real document, and 128 MiB as double the envelope with
  nothing found that needs it.
- **A parsed document may hold one value per 16 bytes of its byte bound**
  (`metadataValueLimit`): 4,194,304 for the abbreviated packument, 6,291,456 for
  the full one. The full packument stays at 96 MiB,
  `MAXIMUM_FULL_PACKUMENT_BYTES`. The largest found is 72.96 MiB
  (`@wix/wix-code-types`) and then 65.35 MiB (`@prisma/client`), so 96 MiB is
  1.31 times the largest, and 64 MiB, which would make the two bounds equal,
  would refuse both whenever an add needs their full document: a package
  modified within the release-age window, which for `@prisma/client`, with 525
  versions in a year, is a matter of days. The count is derived rather than
  chosen so that it cannot fall behind the bytes again. The most values any
  document found holds is 1,077,961 abbreviated (`@prisma/client`) and 2,655,900
  full (`@wix/wix-code-types`), so the limits are 3.9 and 2.4 times that, and
  below what a body of `[1,1,1]` would make (two bytes a value). Other documents
  keep the 200,000 default. The parser enforces it as it builds the tree and
  refuses the first value past the limit; it never counts a finished tree.
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
  bytes, too many values, too deep, not JSON, not UTF-8) now surfaces from
  `publishTime`, named by package and document, and `capturePublishTime` keeps
  it on the facts as `publishTimeUnavailable`; the release-age check appends it:
  `publishedAt/evaluationTime not captured for minimum release age: The full packument of example-heavy is 100663297 bytes (96.00 MiB) and exceeds the limit of 100663296 bytes (96.00 MiB)`.
  A registry that is down, or answers with an error status, leaves the message
  as it was.
- **What a refusal repeats from the registry's document is made plain first.**
  The parser names the member it found twice, and a refusal names the package;
  both are text a registry chose, and the message goes to a terminal and into
  the policy's report. `safeEcho` (`@openpacker/canonical`) is the one place
  that text is made fit: at most 64 characters (214 for a package name, the most
  npm allows), terminal escape sequences removed whole, every control, format
  and separator character removed, lone surrogates too, and the original length
  appended when it cut, or when nothing was left to show of a text that was not
  empty (`Duplicate object member: … (2 characters)`). A key of a title-setting
  escape sequence, `x`, a newline, `y` and 2 MiB of `k` used to give a message
  as long as the key, escape and newline in it. It gives
  `Duplicate object member: ` and `xy` and 62 `k`, then
  `… (2097170 characters) at byte N`.

### The value limit is a budget the parser stops at

The first version of this amendment counted values after `json()` had built the
tree, and said that a hostile registry was allowed no more of the client's
memory by a packument than by a tarball, with a worst case of 1.5 GiB. Both were
wrong, and an independent review measured it. The byte bound lets a body of 64
MiB through, and a body that dense holds millions of values for its size: `{},`
is three bytes and an object. Counted after the parse, the refusal came only
after every value was built.

The first measurement, one `json()` call on a body of exactly 64 MiB (Node
22.22.0, linux/x64; seconds are from a machine whose load average was 14 to 25
on 4 CPUs, so they are an upper bound and the memory is the figure to read):

| body                                  | counted after the parse | the parser stops at the limit    | read before it stopped |
| ------------------------------------- | ----------------------- | -------------------------------- | ---------------------- |
| `{},` times 22.4 million (67,108,864) | 50.7 s, 7,442 MiB RSS   | 2.0 to 4.4 s, 1,108 to 1,121 MiB | 12.0 MiB               |
| `1,` times 33.6 million (67,108,863)  | 13.7 s, 2,556 MiB RSS   | 0.7 to 1.1 s, 391 to 393 MiB     | 8.0 MiB                |

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

### What one hostile document costs

The two shapes above were the first measurement's, and they are not the worst
there are. The cost of a tree is set by the limit and by what the values are,
and an object is dear: 4.2 million empty objects (`{},`) cost 1,085 to 1,140 MiB
and 4.2 million numbers (`1,`) 382 MiB, and an object with a member in it costs
more again.

This measures fifteen shapes through the real thing, not `json()` alone. A
loopback server sends the document chunked with no `Content-Length`, as a
registry that does not say how much is coming would, to the repository's own
`BoundedFetchTransport` and `NpmRegistryProvider`: `enumerate` for the
abbreviated bound, `publishTime` for the full one, which asks for the full
packument. Every document is exactly the size of its bound. Node 22.22.0,
linux/x64, 4 CPUs shared with other work (load average 2.4 to 11), so the
seconds are probably longer than an idle machine's. The figure to read is the
peak RSS of the client process (`maxRSS`), in MiB (1 MiB is 1,048,576 bytes and
1 GiB is 1,024 MiB), and it moves about 10 percent from run to run.

Two sets of runs make up the table: the fix's own, and an independent review's,
which wrote its own harness, re-ran the heaviest shapes and added four. A range
is the least and the most of the runs made of that shape in both sets, for the
time and for the memory separately: the slowest run is not the run that held the
most. The number of runs is in brackets where there was more than one.

| the document's values                                                         | 64 MiB, abbreviated (4,194,304 values)                            | 96 MiB, full (6,291,456 values)                                  |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------- |
| `{},` (3 bytes a value)                                                       | refused after 12 MiB: 2.8 to 8.5 s, 1,085 to 1,140 MiB (5 runs)   | refused after 18 MiB: 4.5 s, 1,578 MiB                           |
| `1,` (2 bytes a value)                                                        | refused after 8 MiB: 1.2 s, 382 MiB                               | refused after 12 MiB: 1.5 s, 478 MiB                             |
| `{"aaaaaaaaaaaaaaaaaaaaaaaaaa":1},` (the same 26-character key every time)    | accepted: 8.7 s, 1,336 MiB                                        | accepted: 9.5 s, 1,831 MiB                                       |
| the same, each key different                                                  | accepted: 7.8 s, 1,449 MiB                                        | accepted: 12.7 s, 2,051 MiB                                      |
| the same, 20-character keys (14 bytes a value)                                | refused after 54 MiB: 5.0 s, 835 MiB                              | refused after 81 MiB: 7.9 s, 1,183 MiB                           |
| `"<14 characters>",` (17 bytes a value)                                       | accepted: 3.3 s, 862 MiB                                          | accepted: 5.1 s, 1,227 MiB                                       |
| `{"<26 characters, each different>":{}},` (an object in an object)            | accepted: 9.9 s, 1,782 MiB                                        | accepted: 16.6 s, 2,594 MiB                                      |
| the same, 20-character keys (14 bytes a value)                                | refused after 56 MiB: 6.0 s, 1,214 MiB                            | refused after 84 MiB: 9.7 s, 1,741 MiB                           |
| an array of `[]`                                                              | accepted: 19.1 s, 1,555 MiB                                       | not tried                                                        |
| one object of `"<10 characters, each different>":{},` members (16 bytes each) | refused at the end of the body: 17.8 s, 1,628 MiB                 | refused at the end of the body: 43.2 s, 2,646 MiB                |
| one object of `"<12 characters, each different>":{},` members (18 bytes each) | accepted: 22.5 to 28.9 s, 2,169 to 2,655 MiB (4 runs)             | accepted: 40.4 to 43.5 s, 3,149 to 3,653 MiB (3 runs)            |
| the same, with one `€` in the name                                            | accepted: 23.8 to 30.4 s, 2,394 to 2,683 MiB (3 runs)             | accepted: 37.1 to 44.1 s, 3,807 to 3,956 MiB (3 runs)            |
| the same, with 7-character keys (13 bytes each)                               | refused after 52 MiB: 52.2 to 60.6 s, 1,412 to 1,484 MiB (3 runs) | refused after 78 MiB: 91.1 to 100 s, 2,244 to 2,347 MiB (3 runs) |
| the 7-character one, with one `€` in the name                                 | refused after 52 MiB: 60.8 s, 1,547 MiB                           | not tried                                                        |
| an object with 11 characters and a `€` in each key                            | accepted: 26.0 s, 2,631 MiB                                       | accepted: 48.0 s, 3,851 MiB                                      |

A gzip response gives the same figure (the `{},` document: 4.6 s and 1,121 MiB
against 5.2 s and 1,140 MiB), because the transport counts decoded bytes.

What the heaviest of them cost, by bound. Within a cell the time and the memory
are of one shape; the two cells of a row are two different shapes:

| bound               | the most memory                                                                                               | the longest                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 64 MiB, abbreviated | 2,169 to 2,683 MiB (2.1 to 2.6 GiB) in 22.5 to 30.4 s: one object of 12-character keys, with or without a `€` | 52.2 to 60.8 s at 1,412 to 1,547 MiB (1.4 to 1.5 GiB): one object of 7-character keys, with or without a `€` |
| 96 MiB, full        | 3,149 to 3,956 MiB (3.1 to 3.9 GiB) in 37.1 to 44.1 s: the same object                                        | 91.1 to 100 s at 2,244 to 2,347 MiB (2.2 to 2.3 GiB): the same 7-character object                            |

Reading it:

- The earlier figure here, "at most about 1.1 to 1.2 GB and 3 to 10 seconds",
  was the cost of two shapes and is withdrawn. So is its first replacement,
  which gave one number for each bound (2.7 GB and 52 s, 3.8 GB and 91 s): the
  review's three runs of the 96 MiB `€` shapes (3,851, 3,894 and 3,956 MiB) were
  all above the 3,807 MiB first measured for the 12-character one, and each pair
  put the time of one shape beside the memory of another. These are the heaviest
  shapes tried, over the runs made, and nothing here shows that no heavier one
  exists.
- The `€` was first thought to make the 12-character object dearer, from a
  single run (2,683 MiB against 2,169 to 2,432 MiB for the object without it).
  The review's runs overlap (2,655 MiB without it, 2,676 and 2,394 MiB with it),
  so the explanation is not shown and is dropped.
- The worst shape is one object with millions of members, each an empty object.
  The tree is dear and so is the time: 6 to 15 microseconds a member, growing a
  little faster than the size (5.3 microseconds a member at 250,000 members and
  7.9 at 2,000,000, measured separately). The parse is on the main thread, so
  the command is stuck for that long.
- A refusal is not cheap. It comes when the tree has the limit's worth of
  values, wherever that is in the body, so a dense body is refused having built
  as many values as a sparse one is accepted with: the object with 7-character
  keys was refused after 52.2 to 60.8 s, longer than the accepted one with
  12-character keys (22.5 to 30.4 s). Reading less of the body is the only
  saving.
- These figures are a constant of the limits and not of the registry: a larger
  body is refused on bytes before it is parsed.

The lever is the 16 bytes a value, and it is not a cheap one. 32 would halve the
values allowed and so roughly the worst case, but it would be 1.1 times the
densest real document found (28.8 bytes a value), so a real document would be
refused for its values before its bytes. What would lower the cost without
refusing a real document is a cheaper tree (the parser builds a null-prototype
object and a `Set` for every object and calls `JSON.parse` for every string), or
weighing objects and members in the budget instead of counting every value
alike. Neither is done here.

### Not done: reading only what the walk needs

Parsing less of a packument was considered and not done. The walk picks a
version by range, so any version may be inspected; it needs the version list,
the dependency fields and `dist` of nearly all of them, and the abbreviated
document has already dropped everything else. The provider also keeps the body
it read, which is what the record's evidence refers to. A projection would save
tree memory, which the measurements above show is the largest cost of a hostile
document, at the cost of a second parser on the path every locked package takes.
It remains an option for lowering that cost.

### Memory

Three parts, and only the first is a bound on the resolve.

1. **Bytes in flight.** A request takes one of twelve slots, and a body may be
   as large as its request's bound: 64 MiB for an abbreviated packument, 96 MiB
   for a full one, and up to twice that for the instant the chunks are joined.
   By arithmetic from the bounds, not by measurement, twelve full packuments are
   1.1 GiB, and 2.3 GiB while joined. An artifact download has the same shape at
   128 MiB. `MemoizingTransport` keeps at most 256 MiB of abbreviated bodies,
   and those are the buffers the provider holds anyway; a full packument asks
   for more than the memo's ceiling and is not kept.
2. **One parse**, in the tables above: 2,169 to 2,683 MiB (2.1 to 2.6 GiB) for
   an abbreviated packument and 3,149 to 3,956 MiB (3.1 to 3.9 GiB) for a full
   one, in the shapes tried, one at a time because the parse is on the main
   thread.
3. **What a resolve keeps.** The provider keeps every packument it has read, the
   body and the tree parsed from it, until the resolve ends: the resolve never
   asks it to forget one. One provider reading six different 12 MiB packuments
   held, after a collection, 188, 258, 328, 398, 468 and 538 MiB of heap, and
   the review's rerun gave the same six figures: 70 MiB for each, 5.8 times its
   size and beside the body itself, and linear. The documents were the dense
   shape `{"<26 characters, each different>":1},` repeated, 33 bytes holding two
   values, because that shape is accepted whole. A real packument holds a value
   per 29 to 35 bytes (28.8 for the densest found), about half as many for its
   size, so 5.8 times is probably high for one; a real packument was not
   measured. So the bound is on a document and not on a resolve, and a registry
   that has the walk visit enough packages can make it hold as much as it likes.
   It could at the old 8 MiB bound too; what has changed is that a document may
   now be eight times the size. A cap on what a resolve keeps is not here.

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

The largest documents found, on the final build. The first two rows are the wall
time and peak RSS of the `opm` process; the last two call `publishTime` of the
real provider in a script, which reads the abbreviated packument first and then
the full one:

| command                                                             | wall   | peak RSS |
| ------------------------------------------------------------------- | ------ | -------- |
| `opm resolve pkg:npm/%40prisma/client` (36.41 MiB abbreviated)      | 9.0 s  | 525 MB   |
| `opm resolve pkg:npm/public-unscoped-test-package` (36.56 MiB)      | 7.1 s  | 487 MB   |
| full packument of `@wix/wix-code-types` (72.96 MiB, then 25.94 MiB) | 9.5 s  | 1,031 MB |
| full packument of `@prisma/client` (65.35 MiB, then 36.41 MiB)      | 13.6 s | 819 MB   |

Both resolves exit 0. `opm add pkg:npm/%40prisma/client` reads the same
packument and then stops at its tarball with
`Unsafe archive rejected (EXPANDED_SIZE_LIMIT): 67108864`, which is the
archive's bound on what it expands to and is not touched here.

### Limits

- The other ecosystems' metadata bounds (cargo, PyPI, NuGet, Go, Maven: 8 MiB
  each) were not measured against their registries here.
- The value limit allows a tree that costs, in the shapes tried (above), 2,169
  to 2,683 MiB (2.1 to 2.6 GiB) in 22.5 to 30.4 s for an abbreviated packument,
  or 1,412 to 1,547 MiB (1.4 to 1.5 GiB) in 52.2 to 60.8 s in the slowest shape;
  and 3,149 to 3,956 MiB (3.1 to 3.9 GiB) in 37.1 to 44.1 s for a full one, or
  2,244 to 2,347 MiB (2.2 to 2.3 GiB) in 91.1 to 100 s in the slowest. A tighter
  limit is a change to `MINIMUM_BYTES_PER_METADATA_VALUE` and to the tests that
  pin 4,194,304; a cheaper tree or a budget that weighs objects is a change to
  the parser. Neither was made here.
- A document the bounds let through can be fatal under a small V8 heap. The 64
  MiB object of 12-character keys, accepted whole, ended the client with
  `FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory`
  and exit 134 under `--max-old-space-size=1536`, not with a refusal (the review
  saw it, and a rerun for this amendment did); at 2048 it finished (2,293 MiB
  peak in the review, 2,176 MiB in the rerun). The default limit on the 16 GB
  machine these runs were made on is 8,240 MiB, so no run in the tables above
  crashed, and a process started with a lower limit can be ended by a document
  the bound accepts. The review's 96 MiB `€` object finished at
  `--max-old-space-size=3072` and peaked at 3,372 MiB.
- A resolve keeps every packument it reads (above), so the bounds on a document
  are not a bound on a resolve. Not changed here.
- What the tests hold: the stop at the limit for `{},` and `1,` at exactly 64
  MiB (`packument-hostile.test.ts`, which asserts where the parser stopped and
  not how long it took), the same stop at small limits and by depth, and the
  refusals and what they say. The other nine shapes, the 96 MiB bodies, the
  two-byte case, the gzip case and the retention of a resolve were measured by
  scripts run for this amendment, which are not in the repository, and no test
  fails if the figures above change.
- The full packument of `@wix/wix-code-types` is at three quarters of its bound
  (72.96 of 96 MiB), though it grows only 0.35 MiB a year. `renovate`'s is at 71
  percent (68.58 MiB) and grows 20.85 MiB a year, so at last year's pace it
  reaches 96 MiB in about 1.3 years, and its abbreviated document reaches 64 MiB
  in about 2.9; the bounds should be revisited before then. Raising the full
  packument's bound means accepting that the heaviest 96 MiB shape costs about
  one and a half times the memory of the 64 MiB one (3,956 MiB against 2,683 MiB
  at the tops of the ranges), and for the slowest shape 1.5 to 1.9 times the
  time (91.1 to 100 s against 52.2 to 60.8 s).
- The sample is 4,887 names and the full packument of 400 of them (above); it is
  not the registry, and it missed `renovate`, which a second look found.
- Parsing is the cost of a large document: the canonical parser reads 12 to 16
  MB a second, `next`'s packument takes 1.6 s, and the resolve of `next` is
  CPU-bound at 22 s.
- `opm add` of `@prisma/client` and `@wix/wix-code-types` stops at their
  tarballs on the archive's expanded-size bound (64 MiB), a different limit that
  is not changed here.
