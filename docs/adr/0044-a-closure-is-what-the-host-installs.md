# 44. A closure is what the host installs: evidence, objectives and a single-version lock

Date: 2026-10-11

## Status

Accepted. Amended by
[0054](0054-aliases-and-several-versions-in-the-closure.md): an `npm:` alias is
followed (§1) and a lock may hold several versions of a package (§4).

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
   registry, and only where the ecosystem's adapter exports a codec: choosing
   among releases and reading what they require takes the ecosystem's own
   version grammar, so a package served by a delegated adapter plugin, which
   exports none, is locked as the direct entry it is and its dependencies are
   not walked. Without a codec nothing can tell a range or a dist-tag from a
   version either, so the host resolves no hint for such a package: whatever the
   manifest wrote after `@`, a `^` or `~` range or a tag included, is sent to
   the plugin as written (`targetAsWritten`), as the PURL's version. The hint is
   text, not PURL syntax: the request is built from the manifest's parsed `purl`
   with the hint as its version (`purlAtVersion`; `^1.0.0` is asked for as
   `@%5E1.0.0`), read back, and must name the same type, namespace, name and
   qualifiers, no subpath, and the hint as its version, so an `@`, `/`, `?` or
   `#` in the hint cannot name another package, a qualifier or a subpath, and a
   hint no PURL can carry is refused before the plugin is asked. The identity
   the plugin answers with must carry that same package and version, so a plugin
   cannot turn a range into another release: it accepts the hint as the version
   it names, or the resolve fails. A version line for an ecosystem with a codec
   that reads it as a version (Maven's reads any text without a space) is built
   the same way. Only a requirement with no hint lists the plugin's releases and
   takes the newest the policy's minimum release age allows. The policy, digest
   and size refusals propagated before and still do.

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
108 more names chosen for weight and 6,516 from 54 further searches (the
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
  parsing them costs (the cost limit below does) or what a resolve keeps (the
  retention budget does): see "Memory". 32 MiB was rejected as below the largest
  real document, and 128 MiB as double the envelope with nothing found that
  needs it.
- **A parsed document is limited by what its tree costs, not by how many values
  it holds**: 512 MiB for the abbreviated packument (`PACKUMENT_PARSE_COST`) and
  720 MiB for the full one (`FULL_PACKUMENT_PARSE_COST`), in the estimated bytes
  of heap that `PARSE_COSTS.peak` (`@openpacker/canonical`) gives each part of
  the tree as the parser begins it: an object 240, a member 60 and its name 3.5
  a character, a number in an array 90, a string 50 and 2 a character, twice
  that for two-byte text. "A budget that weighs what a tree allocates" below has
  the measurements. The first version of this decision derived a count of values
  from the byte bound, one per 16 bytes (4,194,304 for the abbreviated packument
  and 6,291,456 for the full one), and a count let 3.7 million empty objects
  through at 2.1 to 2.6 GiB; it is replaced. The full packument stays at 96 MiB,
  `MAXIMUM_FULL_PACKUMENT_BYTES`. The largest found is 72.96 MiB
  (`@wix/wix-code-types`) and then 65.35 MiB (`@prisma/client`), so 96 MiB is
  1.31 times the largest, and 64 MiB, which would make the two bounds equal,
  would refuse both whenever an add needs their full document: a package
  modified within the release-age window, which for `@prisma/client`, with 525
  versions in a year, is a matter of days. The costs of the heaviest real
  documents are 259.5 MiB (`renovate`, abbreviated) and 598.0 MiB
  (`@wix/wix-code-types`, full) since an object's member table is charged at its
  size (219 and 562 before), so each limit is 1.97 and 1.20 times the heaviest
  real document it reads, and a real packument may cost at most 85 percent of
  its limit ("The member table charged"). Other documents keep the 200,000 value
  limit and, since the review of 2026-10-17, a cost limit of 256 MiB
  (`DEFAULT_METADATA_PARSE_COST`, "A member named by an array index"). The
  parser enforces the limit as it builds the tree and refuses the first part
  past it; it never counts a finished tree.
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
- **The CLI makes what it writes of an error plain, once, and keeps its lines.**
  A `safeEcho` at each site that repeats registry text kept missing one. A
  review found a dependency's name and range in `UNSUPPORTED_DEPENDENCY_SPEC`
  and the `modified` timestamp in the release-age check that passes, and a probe
  after it a version string in `Invalid version`, each with its escape sequences
  intact (V8 reads a parenthesised comment after a date as part of the date, so
  `2020-01-01 (<escape>)` is a time). The sites that were found now use
  `safeEcho` (the dependency's name, range and owner in the three messages of
  `dependency-spec.ts`, `Invalid npm coordinate`, and the policy's bound). The
  writer, `report` in `apps/opm/src/error-report.ts`, is a second layer under
  them, and passes every message through `plainText` (`@openpacker/canonical`,
  the same reading as `safeEcho` without the cut): escape sequences and control,
  format and bidirectional characters are removed, a tab and the other layout
  (vertical tab, form feed, U+2028, U+2029) is one space, a carriage return,
  alone or before a line feed, is a line feed, and NEL is removed. A tab, or any
  other layout, at the start of a line is removed and not spaced, so a child's
  stderr that is indented with tabs (the delegated provider's, which
  `PACK_FAILED` carries) loses its indentation. The line feeds a message carries
  are kept, because several of opm's own errors are lists, one entry to a line:
  the closure `opm add` could not lock ("What the walk could not use:" and an
  entry to a line) and the four lists of `opm ci` (entries it cannot install,
  packages the policy refuses, packages from a git source, packages missing from
  the store offline). A first version of the writer made every message one line,
  which ran those lists together after their colons and made "a message with
  nothing to remove is written as before" true of one-line messages only.
  `apps/opm/test/error-lines.test.ts` pins the text of each: the four `opm ci`
  lists through `runOpm` against lock files, and the closure message as the real
  walk builds it, which `packages/opm-project/test/closure-refusal.test.ts` pins
  against the walk.
- **The writer cannot flatten what it cannot tell apart, so the sources do.** It
  does not know an entry opm wrote from a line a registry added, so a line feed
  that reaches it from a registry starts a line of its own, in plain text. A
  review drove the real binary against a hostile PyPI registry whose
  `requires_dist` entry was `dep[x`, a line feed, `opm: internal error: forged`,
  a line feed, an erase and `opm: ok installed 1 package`: `opm add` printed
  four lines and `opm resolve` six, with the failing exit code beside a line
  that said "ok". Every package that quotes a registry's document therefore
  makes the text it quotes one line where it quotes it, with `safeEcho` (256
  characters; npm's dependency text has its own limits, 200 to 214): `echoed` in
  `@openpacker/adapter-core` for its shared parsers (PURL, version, range, VERS,
  identity and digest algorithm) and for adapter-pypi, adapter-cargo,
  adapter-nuget, adapter-maven, adapter-golang, the OCI provider,
  registry-client, the plugin store (`registry.ts` and the archive it unpacks:
  the manifest's schema reasons, the executable it names, the entry names it
  lists), adapter-host's definition version and the four host-manager adapters
  (apt, Chocolatey, winget and Nix, whose refusals repeat a PURL that a person
  or a project file names and that `parsePurl` accepts with a line feed or an
  escape in it); `safeEcho` itself in the OCI client (the registry's error body,
  token scope, media types and digests) and the materializer (the name of an
  archive entry, in the fifty "Unsafe archive rejected" refusals); and, from
  round 4, npm and the policy. Against the same registry, with `cat -v`:
  `opm add` prints one line, and `opm resolve` its three real ones. A plugin
  registry was missed by round 6 and is the same: against a registry whose entry
  names itself with a line feed, `opm plugin add foo@1.0.0` wrote 3 lines, two
  of them forged; it writes 1. Each package has a unit test of its messages that
  failed on the sources before the change, and
  `apps/opm/test/error-sources.test.ts` reads a hostile document with the real
  adapter and writes the error with the real handler: it failed first for PyPI
  (4 of 6), NuGet, Maven and OCI, and `apps/opm/test/error-plugin.test.ts`
  drives `opm plugin add`. The Cargo and Go cases of `error-sources.test.ts`
  also fail on the sources of round 5 (`8713e6d`): their own sites cannot be
  reached by a document (a Cargo coordinate and a Go module path come from the
  caller; a Cargo target and a Go build constraint are recorded as meaning lost
  and are not errors), but a hostile version reaches the shared parser, which
  was not flat either. An earlier version of this ADR called them controls; they
  are not. The host-manager adapters have unit tests only (they failed first:
  apt 4 of 5, Chocolatey 3 of 4, winget 4 of 5, Nix 6 of 7); I found no road to
  those messages through the binary, because `opm resolve` and `opm install` of
  those types stop at "does not advertise prex.registry.package-metadata/1".
  `echoed` says a value that is not text as a template literal does
  (`undefined`, `null`, `x` for an array), so a field a registry left out or
  typed oddly is still the coded error it was and not an uncoded `TypeError`.
- **A cloned repository's files reach the terminal, and these sites flatten
  them.** The commands a person runs after `git clone` read `package.json`,
  `package-lock.json`, `opm.toml` and `opm.lock.json`, and their values are
  repeated in the errors those commands raise. A line feed in a value (or a
  carriage return, which the writer reads as one) started a line of its own
  (`opm: ok installed 1 package@1`) from a dependency name package.json named, a
  `lockfileVersion`, a version, a name, an `os`, a link's target, a workspace
  member's name, a dependency key that was not a string, a lock's
  `schemaVersion`, `generatedBy`, alias and format, a manifest's purl, version,
  layout, section name and plugin digest, and from the text of a JSON or TOML
  syntax error. Found by putting a payload (a line feed, a line that looks like
  opm's, a list entry and an erase) in every string, number and key of the four
  files in four layouts and running `ci`, `import --native`, `list`, `why`,
  `install`, `sync`, `update`, `uninstall`, `remove`, `gc`, `generations` and
  `manifest`, reading both streams: 1,578 runs, 98 forged outputs on `3bf90c5`
  and none now; and the files corrupted as text (the payload before, after and
  inside them, with line feeds and with carriage returns), 252 runs, 28 on
  `3bf90c5` (all carriage returns in `opm.toml`) and none now. `echoed` wraps
  the untrusted part where each message is built in adapter-npm
  (`frozen-lock.ts`, `frozen-select.ts`, `lock-tree.ts`), opm-project
  (`frozen-*.ts`, `lock.ts`, `toml.ts`, `project.ts`, `install.ts`, `update.ts`,
  `paths.ts`, `catalog.ts`, `spec.ts` and the smaller modules) and the closure
  message. Where a message is a list, the separators are opm's and each entry's
  parts are flattened: `opm ci`'s four lists, and "What the walk could not use"
  (the PURL `echoed`, the reason `plainLine`d). The stdout of `opm list`,
  `opm why` and `opm import --native` printed the same values with nothing
  between them and the stream, and a raw escape sequence; they go through
  `plainLine`, which cuts nothing (`apps/opm/src/stdout-lines.ts`,
  `whyPackage`). `apps/opm/test/error-repo-npm.test.ts`,
  `error-repo-opm.test.ts` and `stdout-repo.test.ts` run the commands through
  `runOpm` with the payload and with `x` in a field and compare the lines
  written: 14 of 15, 12 of 12 and 12 of 13 failed on `3bf90c5` (the others are
  controls). The method reaches what the commands reach from these files in a
  project with no installed packages. It did not drive the paths that need a
  populated store (a successful install), the files `opm pack` reads, a catalog,
  the state under `.opm`, or a plugin's output; the next entry is what an
  independent review found on the first of those and on the commands that read
  these files and are not an install.
- **The success output, `opm run`, `opm exec` and the loss reports read the same
  files, and four places still repeated them raw.** (1) A successful `opm ci`
  wrote `install script not run: <name>@<version>` from the lock's `name` and
  `version`, and the `skipped` and meaning-lost lines from the lock. (2)
  `opm run` listed a script's name and command from `package.json` on stdout,
  repeated the names in the "no script" error and the syntax message of a
  `package.json` that is not JSON. (3) `opm exec <bin>` named the lock's alias
  and PURL as the package that would provide the bin. (4) `opm manifest`,
  `opm pack`, `opm import --native` and a host install wrote each lost meaning
  as `report('opm: ', code + text)`: the text `opm manifest` writes repeats the
  lock's `ecosystem`, and the text `opm pack` writes names the environment files
  it left out by their paths in the tree
  (`NORMALIZED_SENSITIVE_FILES_EXCLUDED`), so a file named
  `.env.<line feed>opm: ok installed 1 package@1` printed that line (the
  review's fuzz ran `pack` with `--dry-run` and did not reach it). A line feed
  in any of them started a line, and the success and listing lines went to
  stdout, which the writer does not guard. Each is `plainLine` at the site that
  builds the text (`commands/ci.ts`, `commands/run.ts`, `opm.ts`); `run.ts`
  reaches it through a dynamic `import()` on the paths that need it, because
  starting a script imports nothing but Node and its own directory (ADR 0047,
  `run-load.test.ts`). `noProjectLoss` in opm-project is unchanged: the
  persisted loss keeps its whole text, and the commands that print it flatten
  it. `oneLine` still shows a line feed in a command as the two characters `\n`,
  and now also removes what a terminal acts on; a tab in a script's name or
  command is shown as a space, which is the one change to text with nothing
  hostile in it. `apps/opm/test/plain-output.test.ts` runs the commands through
  `runOpm` with the payload and with `x` in a field and holds both streams to
  the same number of lines, none of which starts like one of opm's, and to no
  escape, C1, bidirectional, carriage-return or other control character. Of its
  14 tests, 13 fail on `a3891a9` (12 forge a line or write a raw escape
  sequence; one is the tab shown as a space) and all pass now; the 14th, a
  command with a line feed, is a control that passes on both. The review's fuzz
  of the successful `opm ci` flagged 6 runs of 828 on `a3891a9` and 0 now; its
  five real-binary reproductions print a forged line or an escape sequence on
  `a3891a9` and none now; and its broad sweep (19 commands, five layouts,
  payload in every string, key and type, and the files corrupted as text;
  102,058 runs) flagged 49 runs on `a3891a9` and 11 now, which are the script's
  own output (8 runs of `opm run build` under the escape payload) and the JSON
  document `opm manifest` prints on stdout (3); the first is a known limit below
  and the second is closed by `outJson` (below). Outputs for text with nothing
  hostile in it (`x` in each field, 2,975 outputs of 13 commands, timestamps
  masked) are identical on both trees.
- **What `echoed` costs.** It cuts a message's text at 256 characters (the OCI
  error body at 1,024), saying how long it was, so a loss record's text and a
  long PURL or URL in a message are cut: a uv.lock dependency marker of 431
  characters gives a loss text of 339. The lock and the native payload keep the
  full value; only the message is shorter, and the text of a `SemanticLoss`,
  which is persisted, changes for such a lock. `safeEcho` drops a line feed
  instead of spacing it (a multi-line registry body reads as words run
  together), and it removes ZWNJ and ZWJ, so a name in a script that needs them
  (`می‌خواهم`) loses them in a message.
- **What reaches the writer raw, and what is not covered.** Some text reaches
  the writer without an adapter or a loader having made it one line. The writer
  removes its escape sequences and control characters, so none reaches a
  terminal, and it keeps its line feeds, so a line feed in it starts a line.
  These are: the plugin host's messages (a plugin's own stderr is appended to
  its errors, up to 2,048 characters, and a manifest's schema reasons name its
  fields; 84 interpolations, not audited), the paths `project-io` refuses while
  it writes an archive, the file names and parser messages of the standard
  packers (`adapters-default`) and of delegated pack providers
  (`pack-provider`), a host installer's, a tool's and a script's own stderr,
  passed through as it wrote it, the messages `apps/opm` builds from the
  person's own arguments (usage errors), and the interpolations in opm-project
  that the commands above did not reach (339 interpolations in opm-project, 338
  raw, are untriaged: counts, line numbers, configured endpoints, environment
  names, project paths, the state under `.opm`, and values read from `opm.toml`
  and `opm.lock.json`, as in `noProjectLoss`, whose text repeats the lock's
  ecosystem; the commands above reach some of them and I did not trace each).
  `receipts` repeats a receipt's text and is depended on by `openpackerd`, not
  by `opm`; `lock-import`, which `openpackerd` and `openpacker-cli` depend on
  and `opm` does not, now repeats a lock's text through `echoedValue` (the
  bullet on the SDK and `lock-import` below); no package depends on `closure` or
  `ocm`. **Not covered at all:** anything outside the command lines of `opm`,
  `openpacker` and the daemon's start. (`apps/openpacker-cli` and
  `apps/openpackerd` were here; they write through the same writers and are held
  by the same scanners now, below.)
- **Known limits of what is claimed above.**
  - The gates hold the writers, not the values. `stderr-writers.test.ts` and
    `stdout-writers.test.ts` fail on a write that does not go through `report`,
    `out`, `outJson` or `outRaw`; `report` and `out` keep a message's line
    feeds, so a new line that repeats a value from a cloned repository still
    forges a line until someone wraps the value in `plainLine` or `echoed` where
    it is quoted. The four findings above were this, and so were the directory
    that `opm run` and `opm exec` quote and the lines of a host install (below).
  - A script's own output passes through raw by design, and so do the shell's
    own lines that echo the script's text (`sh: 1: ...: not found`), a child's
    stderr, and what a host installer or a tool wrote (`outRaw`, which a test of
    `opm add` holds as it is).
  - `opm manifest` writes a JSON document on stdout through `outJson`, which
    writes the characters a terminal acts on inside a string (the C1 controls,
    the soft hyphen, the zero-width and bidirectional characters, U+2028 to
    U+202E, the byte-order mark) as `\uXXXX`. The document parses to the same
    value; JSON escapes the escape character and the line feed itself.
  - A field of the wrong JSON type in `opm.lock.json` or `opm.toml` is held to a
    code by two seeded fuzzes and by the commands (below). The other files the
    commands read were not held to a code by a fuzz of that kind here:
    `package.json` and `package-lock.json` were swept with a payload in every
    string, number and key (above) and not with every type in every field, and
    `auth.json` and the plugin store's index were not driven.
  - The values `opm search`, `versions` and `info` print are made plain at the
    line, and `opm resolve` lists only canonical PURLs (below). They are driven
    by an adapter that words one value at a time
    (`apps/opm/test/hostile-adapter.ts`), not by a registry over a network, and
    the bundled adapters validate much of what they return, so which of these
    values each of them lets through was not enumerated.
  - What the fuzz did not reach: online resolution and the closure message,
    `opm pack` of a real project beyond the environment-file case (the fuzz ran
    `--dry-run`), `opmx`, `publish` and `yank`, `auth.json`, an installed
    plugin's own output, and the Maven, Go, OCI and host-manager adapters
    through the binary (unit tests only). The report lines of a native
    projection, of `opm resolve` and of a host install, the lines of
    `opm system available`, and the directory and the file `opm run` and
    `opm exec` name are driven through `runOpm` with hostile text now (below),
    by an adapter that stands in for a bound plugin and not by a plugin process.
  - The URL guard is a property of the JavaScript call sites the scanner can see
    (above). The Rust crates parse URLs with their own parser and were not part
    of it.
- **The writer reads an unterminated escape string as a terminal would.** An
  `ESC ]` (OSC) or `ESC P`, `ESC X`, `ESC ^`, `ESC _` with no terminator runs to
  the end of the message, so a field that ends in one drops the rest of the
  message it is in, opm's own later list entries included:
  `plainText('Cannot lock: boom\nWhat the walk could not use:\n  - pkg:npm/a@1: evil ESC]0;t\n  - pkg:npm/b@1: the real reason')`
  is `Cannot lock: boom\nWhat the walk could not use:\n  - pkg:npm/a@1: evil `.
  An earlier sentence here, that a line feed "cannot move the cursor, retitle
  the window or hide text", was untrue of that case, and is withdrawn. It is the
  reading round 4's `plainLine` already had, so it is not a regression. At the
  source the same sequence ends with its field, because `safeEcho` reads one
  field and not the message, so a field that ends in one loses the rest of that
  field and no more. A run of blank lines is kept too.
- **Plain before redacted, and NEL is removed, not spaced.** The writer makes a
  message plain before the secrets are withheld, so a zero-width character
  cannot split a credential's name past the redaction. The scrubber reads white
  space as `\s`, which does not match NEL (U+0085), and a NEL turned into a
  space ended a URL the scrubber had read whole: `https://<NEL>user:secret@host`
  printed the credential. A differential run of 300,000 secret-bearing strings
  with up to three noise tokens inserted (seed 99, the review's script) counted
  the strings where the plain step shows a credential the old path withheld: 518
  with NEL spaced, and 0 with NEL removed; the strings where the plain step
  withholds what the old path let through rose from 72,939 to 80,367.
  `plainLine` and `plainText` now space exactly the characters `\s` matches
  (tab, LF, VT, FF, CR, U+2028, U+2029), and a test sweeps the basic plane to
  say so.
- **A name in an error shows what the writer would remove.** The lock reader
  quoted a package name with `JSON.stringify`, which leaves format characters as
  they are, so a name differing from `member` only by a zero-width space, a
  right-to-left override and NEL was refused as
  `"member" is not a safe directory name for node_modules`, which read as untrue
  once the writer had removed them. `quoted` (adapter-npm) writes each such
  character out:
  `"member\u{200b}\u{202e}\u{85}" is not a safe directory name for node_modules`.
  Only the lock reader's own messages change; the writer is the same.
- **Reading a message is linear.** The first `plainLine` asked the string it was
  building whether it ended in a space, once for each character, and V8 flattens
  a string that is still being built for that. A message of 64,000 lines of
  `line` (320,000 characters) took 5.5 s, the review's 1,000,000 characters took
  55.7 s, and `adapter-pypi`'s echo of a 500 KB requirement of 100,000 lines
  took 14.1 s in `handleError`. It keeps the last character appended in a
  variable. With a load average of 5 to 9 on 4 CPUs, six shapes (a word to a
  line, a space and a break, a tab, a CRLF, a zero-width character, plain text)
  took 16 to 63 ms at 320,000 characters and 69 to 196 ms at 1,048,576 in
  `plainLine` (two runs), and 17 to 40 ms and 85 to 171 ms in `plainText` (one
  run). Through `report`, 1,000,000 characters of lines took 198 ms, and the
  100,000-line requirement through `handleError` 61 ms. The tests of both fail
  above 2 s. Time is linear and memory is not small: the reading appends one
  character at a time, so a message of 8 MiB held 272 MiB of heap while it was
  written (about 33 bytes a character, a string node for each), peaked at 345
  MiB of RSS and took 2.1 s, and one of 64 MiB took 2.2 GiB and 13 to 15 s in
  the review's runs. Nothing opm builds is that long: the adapters cut what they
  quote and a document's size is bounded by the limits above.
- **Withholding is linear, and a host no DNS name could be is not handed to the
  URL parser.** `scrub` (`apps/opm/src/scrub.ts`) began a scan again at every
  word boundary of a long run: `a-` repeated to 80,000 characters took 12.3 s
  (13.2 s through `formatFailure`), `a.` 4.6 s, and a mebibyte of `a.` 18
  minutes and of `a-` 40. It finds each `://` and reads its scheme backwards,
  and starts the credential match at the name, and gives the same text byte for
  byte (`scrub-differential.test.ts`, against the first version, frozen). A
  mebibyte of each hostile text takes 10 to 35 ms, and 175,000 short URLs 0.1 to
  0.2 s. Two outputs changed on purpose. The first: Node's URL parser takes time
  that grows with the square of the length of the host of a special-scheme
  address when the host is many non-ASCII labels, written raw or percent-escaped
  (`'http://'` and `'ß.é.'` repeated, one call in a fresh Node 22.22 process on
  4 CPUs at a load average of 6 to 8, which is not low and could not be made
  low: 65,543 characters took 0.9 s of CPU, 131,079 took 4.4 s, 262,151 took 21
  s and 524,295 took 95 s, 105 s of wall time; each doubling costs 4.7 to 4.9
  times as much, and the first call is four times a later call on the same text
  in the same process, 0.23 s at 65,543. An earlier version of this record said
  1.2 s at 65,536 and 37 s at 524,295, which are not one curve: 64 times 1.2 s
  is 77 s). A host of ASCII or punycode labels is fast, and so is the host of
  any other scheme than `ftp`, `http`, `https`, `ws`, `wss` and `file`, which is
  opaque (2 to 21 ms for a mebibyte, raw or percent-escaped). No host over 253
  characters is a DNS name, so `hasOverlongHost` (`@openpacker/canonical`,
  `url-host.ts`; `@openpacker/adapter-core` re-exports it) is asked before the
  parser is: `scrub` and `redactSource` print such a URL as `[url]`,
  `classifyResolved` refuses a lock entry whose `resolved` names one, and
  `opm ci` of a lock with a 524,288-character host, which took 146 s, answers in
  0.74 s.

  The helper reads the host as Node's parser does, and Node's parser is the URL
  Standard's with one difference that matters here. State by state, as the
  Standard has it: leading and trailing C0 controls and spaces are stripped and
  tabs and newlines removed; after a special scheme the slashes and backslashes
  are skipped, however many there are; the authority ends at `/`, `\`, `?` or
  `#` and its userinfo at the LAST `@`; the host ends at the first `:` that is
  not inside brackets, and a `[` anywhere in it switches the port colon off
  until a `]`; a `file:` host is the whole authority, with no userinfo and no
  port, and a drive letter is no host; a `blob:` URL is read at the address in
  its path, which its `origin` parses again. The difference, found by timing the
  parser and not by reading the Standard: when the host ends inside a `[` that
  no `]` closed and does not begin with `[`, Node reads it on, past `/`, `?` and
  `\`, to the next `#` or the end of the input (`http://x[h.test/` and 128 KiB
  of `ß.é.`: 1.1 s; 512 KiB: 106 s), so the helper counts that tail as host. The
  first version of the helper took the host to end at the first `:`, read
  `file:` as it reads `http:`, and read every scheme as a special one; the
  second followed the Standard and missed the tail (28 of the 13,457 forms of
  the third review's grid, and 9 of them over 300 ms at 64 KiB).

  What holds the reading, and what it cannot show (the tests are in
  `packages/canonical/test`, where the helper moved to, so that `trust`,
  `packslip` and the SDK, which cannot depend on `adapter-core`, can ask it).
  `test/whatwg-host.ts` runs the Standard's states over code points, states the
  one difference, and where Node's `new URL` accepts one of 400,000 generated
  addresses and leaves its host as written (42,664 of them) the two agree on the
  host. The helper equals that reading on every string of nine delimiters up to
  five long after 11 schemes and two edge forms (1,461,460), on 600,000 random
  strings and on the families that were counted short at six sizes. Because both
  are written from the Standard, neither can show where Node differs;
  `test/url-host.parser.test.ts` times the real `new URL` on 7,758 addresses (12
  spellings of scheme, two slash forms, 14 hosts with stray brackets and
  userinfo, 14 delimiters, 32 KiB of `ß.é.`, a seeded sample of the product, and
  the review's forms also with 96 KiB of percent-escaped labels) and requires
  every one the helper lets through to take under 25 ms (the shapes it found
  take 60 ms at this size). It runs in 2 s. Measured outside the test: 5,670
  forms of an enumeration of this author's (9 schemes, 12 slash forms, 52
  structures, edges) at 64 KiB of raw `ß.é.`, 192 KiB of percent-escaped labels,
  and 1 MiB of ASCII and of punycode labels; the third review's 13,457 forms at
  32 KiB of raw `ß.é.` and at 96 KiB of percent-escaped labels (3,578 over 25 ms
  in each, 5,309 withheld, none that took over 25 ms let through; the slowest
  let through 6.4 and 8.7 ms) and at 1 MiB of ASCII (none over 25 ms let
  through; the slowest 16 ms); and 150,000 random delimiter strings at 16 KiB (6
  not withheld, none of the stray-bracket class, each linear and under 0.2 ms).
  Fifty-six changes of one token each to the helper: 50 are failed by a test
  (one by a loop that never ends), and the six that are not give the same
  answers as the helper on all of the above.

  What it withholds that the parser reads fast, so that this is not mistaken for
  a measurement of slowness: any special-scheme host over 253 characters as
  written, whatever it is made of (at 1 MiB of ASCII the parser accepted 1,236
  of the 2,986 withheld forms and refused the rest); a bracketed host the parser
  refuses in under a millisecond; an unclosed `[` followed by a long tail the
  parser would refuse anyway; and a host written over 253 characters that is
  shorter once its percent-escapes are decoded (`%61` a hundred times is a name
  of 100 characters written in 300). What it stopped withholding: a scheme the
  parser reads in linear time (`git+https://`, `x://`, `socks5://`, `blob:` with
  a path that is no address), and a `file:` address whose host is empty or is
  not there. The price of printing them is the second change.

  The limits, all of them. The grid is a grid: a way of writing a host that no
  address of it has is not covered, and the 16 other alphabets of the second
  review were not re-run on the third review's forms. It was written and
  measured on Node 22.22 on Linux; another Node (another ada) may read hosts
  differently in either direction, and `url-host.parser.test.ts` is where that
  shows.

  Where the helper is asked. `parseUntrustedUrl` (`@openpacker/canonical`,
  `untrusted-url.ts`) is the one way to read a URL that someone else wrote. It
  asks `hasOverlongHost` of the text, and of a base given as text, before the
  parser sees either; it throws what `new URL` throws for an address the parser
  refuses, and an `OverlongHostError` (also a `TypeError`, with a fixed message
  that repeats none of the address) for a host longer than a name can be; a
  reference with no scheme (`//host`, `\\host`, `/\host`, a tab between the
  slashes) is asked about with its base's scheme in front, and a relative path
  that begins with a long segment is not a host and is resolved as before. On a
  65,536-character host of `ß.é.` the real parser took 1,126 ms on its first
  call here and 265 to 275 ms on the next two (Node 22.22, a load average of 6
  to 9), and the guard took 8.9 ms on its first and 0.4 to 0.6 ms on four more;
  `untrusted-url.test.ts` times one call in a fresh process as its control (a
  worker that has parsed the host already shows the later figure, which failed
  an earlier control in `npm run test:security`: 252.7 ms against 300) and fails
  if the real parser ever needs under 300 ms for it.

  Before this, 56 places in 30 files of `packages/*/src` and `apps/*/src` handed
  text that a registry, a lock, a manifest, a peer or a configured endpoint
  chose to `new URL`, `URL.canParse`, `fileURLToPath` or `fetch`; the tree was
  scanned at `b43dd72` with the scanner below. The artifact location a packument
  publishes (`dist.tarball`, in `registry.ts`, `supply-chain.ts`, the delegated
  host fetch and a lock's source), the registry in `OPM_REGISTRY_<ECOSYSTEM>`
  and the registry of `opm publish` and `opm yank`, the transport's request and
  its redirects and the origins of `firstPartyOriginPolicy`,
  `normalizePinnedOrigin` and `parseProviderUrl`, a NuGet service index's
  resource addresses, the token realm, the next page, the referrers and the
  upload location of an OCI registry and the registry of its PURL, a lock's
  `resolved` in `lock-import`, the URLs of a CycloneDX document and a SLSA
  statement, the addresses of a project, a signed document and a redirect in
  `packslip`, a WinGet `InstallerUrl`, a configured endpoint
  (`adapters-default`, `plugin-store`, `provider-sonatype`, `registry-client`,
  the SDK), and the provider location, the `Host` and `Origin` of a request and
  the publisher's file URL of `openpacker` and the daemon, are read through the
  guard (or, for `fileURLToPath`, through a function of the three that return a
  guarded URL: `parseUntrustedUrl`, `assertReadableUrl`, `providerLocation`).
  Each package (but `adapter-npm`, below) has a test that gives its sites the
  16,384-label host and requires the refusal in under 50 ms (the least of three
  tries) with a message that repeats none of the host. A published location that
  is not a URL is refused as `UNSAFE_PATH` naming the package, and a source a
  person gave to `opm add --source` as `UNSAFE_SOURCE` naming the address as
  `redactAddress` shows it; the first was an uncoded `TypeError` for text that
  was not a URL, and the refusals after it repeated the address in a message of
  262,251 characters. `adapter-npm`'s `classifyResolved` asked `hasOverlongHost`
  already; it now parses with the same call, and has no test of its own.

  `apps/opm/test/untrusted-url-sites.test.ts` holds this against the sources
  (`untrusted-url-scan.ts`, the TypeScript parser, as the stderr scanner does).
  It forbids the reference and does not recognise spellings: `new URL` and
  `new x.URL`, `URL.canParse`, `URL.parse`, the name `URL` used as a value (an
  alias, `Reflect.construct`, an array), `import { URL }` under any name,
  `fileURLToPath` of anything but `import.meta.url` or a call of a guarded
  function, a call of `fetch`, and `new Request`. It reads the production
  sources of every package and app (294 files here) and fails on any use that is
  not in its list of six, which covers seven uses, each with the reason it may
  stay: the guard itself (2, each after the same text was asked about),
  `redactAddress` (asks first), five constant GitHub origins in
  `adapter-packslip`, a test double in `packslip-testkit`, a `file:` prefix that
  fixes the host in `catalog.ts`, and a `fetch` one line after
  `assertReadableUrl`. An entry that no longer matches fails too, and 18
  fixtures that must be caught and 13 that must pass hold the scanner. What it
  does not see: a parse behind a function that is not named in `GUARDED`, a URL
  read by something that is not JavaScript (the Rust crates), and what another
  Node reads differently, as above.

- **A URL is shown cut.** The second change of `scrub`: the URL parser writes a
  character outside ASCII as up to nine (`日` is `%E6%97%A5`), so a URL was
  shown at up to nine times its length. A mebibyte of path, or of a non-special
  host, was 9 MiB; 18 of 60 hostile texts of 1 MiB came out more than four times
  as long, one git lock entry with a 1 MiB host printed 9 MiB through `opm ci`,
  four such entries 36 MiB, and the refusal of a lock lists twenty. `scrub` now
  shows a URL at most twice as long as the text it came from and at most 600
  characters, ending in `…` where it is cut (the worst of the 60 texts: 1.99x;
  the one git entry: 448 bytes). A URL of ordinary length is shown whole.
  `redactAddress` shows a host and a path each at 256 characters and then how
  many there were, and a scheme of up to 32 characters (`[address withheld]` for
  a longer one: a scheme of 1 MiB, which the URL parser takes, was printed
  whole).

  That bounded the URLs and not the text. The passes for a credential name and a
  bearer token lengthen what they find, `token=x,` being 8 characters and
  `token=[REDACTED],` 17, and a seeded search over 20,000 repeating units of up
  to 14 characters (`token=日;`, `token=x,`, ...) found texts that came out
  2.125 times as long. The last step of `scrub` now cuts the whole answer at
  twice the length of the text, ending in `…` as a cut URL does, so "at most
  twice as long" is true of the function and not of each pass: 61 hostile texts
  of 1 MiB (`scrub-bound.test.ts`, with a single URL at most 600 characters in
  the 54 that are one) and the 20,000 units are all inside it. The answer is the
  first version's, byte for byte, but where it is cut
  (`scrub-differential.test.ts`, which names the third class; of 400,000 seeded
  strings 615 differ from the first version, 14 by this cut alone, and the
  oracle explains all of them). The cost: the tail of a path longer than 600
  characters is not shown, and a one-character value after a short name is
  `token=[REDACT…`: the value is withheld, the word is cut.

- **An address named in an error is built from the parser's components, and
  nothing else is printed.** `redactAddress` (`@openpacker/adapter-core`) shows
  the git and path sources `opm ci` lists (`redactSource`), the address in the
  "is not a URL" problem of `classifyResolved`, the two messages of
  `frozen-fetch` that name a source, and the source a person gave to
  `opm add --source` or wrote in `opm.toml` (`fetchArtifactBytes`). It can print
  only the scheme (unless it may be a user name, below); when the URL parser
  accepts the address, the parser's own host (with its port) and path, taken
  from the URL object and never from a slice of the text, never userinfo, query
  or fragment; and the fixed words `[url]` and `[address withheld]`. The first
  redactor cut text ("everything up to the last `@`") and every rule added to it
  (the last `@`, an `@` inside a path segment, an `@` in a query) moved a leak
  somewhere else: a query `?email=a@b.com&sig=<c>` printed `b.com&sig=<c>`, a
  host after an `@` of the path was shown as the host
  (`https://evil.example/x@registry.npmjs.org/p/-/p.tgz` as
  `https://registry.npmjs.org/p/-/p.tgz`), and a password such as `/s3cret/` or
  `1234/s3cret` before the `@` printed.

  Where the parser accepts an address and an `@` comes after its authority, that
  `@` may be where userinfo ends: a password that holds a `/`, `?` or `#` ends
  the parser's authority there, and the `@` that ends the password is then in
  the path, the query or the fragment (`deploy:123/secret@host` is a host, a
  port 123 and a path; `deploy:a@b?c@host` is a user, a password `a` and a host
  `b`). If that part of the address holds no `@`, no password was split. If it
  does, the address is withheld: `scheme:[address withheld]`. The one exception
  is the path of a scoped package's tarball,
  `<prefix>/@scope/name/-/name-<version>.tgz`, whose one `@` begins the scope. A
  scope is `@`, a letter or digit, and letters, digits, `_`, `~` and `-`: no
  dot, because a host has one (`@registry.example.com`). An opaque path
  (`github:u:pw@o/r`, `user:pw@host:o/r`) with an `@` anywhere in it is withheld
  too. An address the parser refuses is its scheme, if the text starts with one
  and the scheme may be shown, and `[address withheld]`, with no cut of the
  text. `blob:` is `blob:` and the same rule on the address in its path, four
  deep and `[url]` below that, and the overlong-host check is made once, of the
  address as written (a legal host of 42 non-ASCII characters inside a blob URL
  is shown, as it is outside one). `file:` and `link:` addresses are paths on
  this machine, where an `@` is a character: they are shown without query and
  fragment.

  What that costs: a scp-like source (`git+ssh://git@github.com:o/r.git`, the
  commonest git form) is `git+ssh:[address withheld]` and a relative path
  (`../pkg`) is `[address withheld]`; an address with an `@` in its query,
  fragment or a path that is not a scoped tarball is withheld whole
  (`https://cdn.example/pkg@1.2.3/f.js`,
  `git+https://github.com/o/r.git?email=a@b.com`, a git ref
  `#semver:@scope/pkg@1`), where the first version showed the host and path; the
  fragment is never shown, so a git ref such as `#semver:^1.2.3` or `#abcdef0`
  is lost. What it does not cover: a user name or a password that ends in a `/`
  and is followed at once by `@scope/name/-/name-<version>.tgz` is a scoped
  tarball path to anyone, and is shown (a test says so); an `@` in a `file:` or
  `link:` address; and a credential that is not next to an `@`
  (`/api/<token>/pkg.tgz` is a path). Of 4,805 `resolved` values in nine real
  locks, 4,590 are shown exactly as written and the other 215 are relative
  workspace paths (`packages/x`), which are `[address withheld]`; none is a
  registry tarball URL.

  The exemption was wider than a password. A credential in std-base64 written
  raw, which holds a `/` and ends in one once in 64, and is followed by the host
  of an unscoped registry tarball
  (`https://<token>@registry.example.com/left-pad/-/left-pad-1.3.0.tgz`), made
  `/@registry.example.com/left-pad/-/file` the path of a scoped tarball when the
  scope could hold a dot. A user name alone needs no digits and was printed
  1.58% of the time (945 and 914 of 60,000 tokens of 24 and 40 characters; the
  password of `ci` 23 and 22 of 60,000, because the parser must read its start
  as a port). With no dot in a scope, none of the same seeded corpora is printed
  (`redact-address.base64.test.ts`), nor any of 3,000,000 user names of each
  length or 23,000,000 passwords. Of 20,000,000 of those passwords, checked with
  no allowance for the public host, three held six letters of it (`gistry`,
  `egistr`, from `registry`) and the output was the public address itself,
  `https://registry.example.com/...`, without any of the credential: a
  coincidence, not a leak. The cost: a scope with a dot (`@my.org`) is
  `https:[address withheld]` like the rest; and a host with one label and no
  port (`@verdaccio`, `@localhost`) is still a scope to this rule, so a
  credential that ends in a `/` and is followed by one is printed.

  A scheme is not always a scheme. `TOKEN:pw@github.com:o/r.git` is a valid URL
  whose scheme is `token`, and `resolved uses token:, not https` and
  `token:[address withheld]` printed the user name of a value no tool writes but
  a person might (a 40-hex classic token that starts with a letter is a legal
  scheme). One function decides, `shownScheme` (`@openpacker/adapter-core`), for
  `redactAddress` and for `classifyResolved`: a scheme is shown when `//`
  follows it (the user name of such an address is after the slashes, and
  `ssh://git@github.com/o/r.git` is `ssh://github.com/o/r.git` as before), when
  it is one opm reads without `//` (`github:`, `gitlab:`, `bitbucket:`, `gist:`,
  `git:` and `git+ssh:`, `git+https:`, `git+http:`, `git+file:`, `git+ftp:`,
  `npm:`, `blob:`, `file:`, `link:`), or when the rest of the address holds no
  `@`, so that there is no userinfo for it to belong to. Any other scheme of a
  text with an `@` after it is not printed: the address is `[address withheld]`,
  and `classifyResolved` says
  `resolved is [address withheld], not an https URL`. An address the parser
  refuses is read the same way from its text. The cost: `user:pw@host:o/r`,
  which was `user:[address withheld]`, loses its `user:` (it may be a name); a
  git shorthand opm does not read (`bb:o/r#a@b`) loses its scheme too. Through
  the real binary, five of six lock entries of this shape printed their user
  name and none does now (`ci-credentials.test.ts`); the sixth, a `blob:`, never
  did.

  A source the person wrote is named the same way wherever opm names it.
  `opm why` printed `source` as `opm.toml` had it, and a source read as a file
  was named by the path made of it:
  `git+https://user:<token>@github.com/o/r.git` is, to `resolve`, a relative
  path, and "Artifact source not found" printed
  `<project>/git+https:/user:<token>@github.com/o/r.git`, as `opm install`,
  `opm sync` and `opm add --source` do. `shownSource` (`opm-project`) is the one
  place that decides. A text that reads as an address (a scheme of two
  characters or more, a single letter and a colon that is not a drive, or
  `user@host:`, after the tabs and line breaks and the controls before it are
  removed, as the URL parser does) is shown by `redactAddress`; a `file:` source
  by its file; any other text is a path on this machine and is shown as written,
  one line. `fetchArtifactBytes` is told what was written (`written`), because
  what it is given is the path. The sweep of 13 cases in
  `source-credentials.test.ts` (six shapes in `opm why`, six in `opm install`
  and one in `opm add --source`) printed its marker 13 times before and prints
  it 0 times now. The cost: a path whose first word holds an `@` and ends in a
  `:` (`a@b:c.tgz`) is read as the scp form and withheld.

  Four more fields of a lock are printed: an entry's `version` and `name`, the
  target of a link, and the key of an entry in `packages`. `echoed` made them
  plain and left an address in them, so a lock whose `version` was
  `https://user:<token>@host/x.tgz` printed
  `p0@https://user:<token>@host/x.tgz (node_modules/p0)`, and so did a name, a
  link target (`a link to <address>`) and a key (also in
  `The lock path "..." is malformed`, through `quoted`). npm writes none of
  these as an address in a lock of version 2 or 3, so only a lock made by hand
  or by an attacker reaches it. `echoedValue` (`@openpacker/adapter-core`) reads
  the value as a terminal would show it, then shows it as `redactText` does: a
  value that is an address by `redactAddress`; a value with a `scheme://...` in
  it, that address, up to the next space, by `redactAddress`; any other value as
  it is. The cut comes last, since a cut address is another address
  (`https://user:123` is a host and a port). `labelOf`, the lock reader's
  refusals, `classifyResolved`'s labels and `quoted` use it. What it does not
  find: a credential that is not next to a `scheme://` (`pkg:token@host` inside
  a longer value), and one that holds a space inside a value that is not itself
  an address. Fourteen hostile lock entries through the real binary
  (`ci-lock-fields.test.ts`: version, name and key as a git source and as an
  offline registry fetch, each with an address behind escape sequences and
  inside other text, and two link targets) all printed a marker or a control
  character before, and none does now; an ordinary version, name, link and key
  are written as they were.

  Held by a property test; the sweeps whose figures follow were run by a review
  with scripts that are not in the repository. A marker is put in the user name,
  in 166 forms of password (every pair of `@ ? # : / %` before, after and around
  it, digits and `/`, `/<marker>/`), in the query, the fragment and the path,
  and in every position of twelve forms the parser refuses (37,364 addresses in
  all): it comes out only where the parser put it in the host or the path with
  no `@` after the authority, and whenever an address is printed, re-parsing the
  output gives the parser's own protocol, host and path with no userinfo, query
  or fragment. `ci-credentials.test.ts` runs 42 lock entries through `runOpm`
  and through the built binary, and `source-credentials.test.ts` the sources a
  person writes. Through the real binary the review's sweep of 1,290 lock
  entries holds 0 markers (3 before), its five `@`-in-query entries are clean,
  and none of its four spoofed hosts is shown; its library sweep of 5,815,824
  addresses leaves 210,528 outputs holding the marker (252,936 before), all of
  them `file:`, `link:` and `blob:file:` paths, none in a remote scheme.

- **Every writer, and the ones left as written.** `handleError` (usage, run,
  `OpmError` and coded errors), `formatFailure` (an error with no code keeps the
  line breaks of its message; its causes are one line each, and so are
  `opmx`'s), the reasons `opm resolve` lists, the plugin that was not loaded and
  the plugin store that could not be used, the paths and reasons skipped and the
  meaning lost in `add`, a host install, `manifest`, `pack` and `opm ci`, and
  `opmx`'s line naming the version it ran and the reason a run could not start
  all use `report`. `apps/opm/test/stderr-writers.test.ts` holds this against
  the sources with the TypeScript parser (`stderr-scan.ts`). It does not
  recognise write calls one spelling at a time, which an independent review beat
  22 times in 26 (a stream handed to a helper, `new Console(process.stderr)`,
  `Reflect.apply`, `import { stderr as e }`, `fs.writeFileSync(2, …)`,
  `io['std' + 'err']`, `console.trace`); it forbids the reference. Any property
  or element access that names `stderr`, an identifier called `stderr`, a
  computed key on `io` or `process`, `console` in any form, `new Console`,
  `process.emitWarning` and a file descriptor 2 is a use; a stream that is
  handed on, kept, bound, applied or put in a conditional is found where it is
  first named. The one allowed form is `io.stderr.write(x)` where the whole of
  `x` is a call to `report` or `formatFailure`, the imported writer and not a
  function of that name declared in the same file. Every other use in `src` is
  named in the test with the reason it may be there, and an entry that matches
  no use fails: a child's own stderr (a host installer's, a tool's, a script's,
  passed through as it wrote it), the process streams at the host seam of the
  run path, constant sentences around a count or an exit status, the usage text
  of `opm auth` (the person's own argument), and the two lines of the run path
  that name a script of the person's own `package.json` or the bin the person
  typed (the run path loads no workspace package, `run-load.test.ts`). The
  scanner is held by 24 fixtures that must be caught, the review's 26 (25
  caught, the 26th is the allowed form) and four more. It scans `apps/opm/src`,
  `apps/openpacker-cli/src` and `apps/openpackerd/src`; every other package is
  outside it. Eleven writers were not routed before this; the plugin-store one
  is also driven for real (a hostile `OPM_PLUGIN_HOME`), and the rest are held
  by the list, because they need a registry or a module mock, which the
  repository's lint rejects.
- **A rejection that skipped the writer.** `case 'system'` in `runOpm`, the
  host-install branch of `add`, and `runSystemCommand` returned another async
  function's promise inside the `try` without `await`, so a rejected
  `opm system <subcommand>` or `opm add pkg:apt/...` that a host installer
  refused went past `handleError`: Node printed the message with its escape
  sequences and exited 1. `return await` fixes the three, and
  `apps/opm/test/error-reach.test.ts` drives them through `runOpm` (and, by
  hand, the built binary under `cat -v`: exit 2 and 3, no escape sequence). The
  other `return <call>(` sites in `apps/opm/src` are in functions with no `try`
  of their own, whose callers await them (`rollbackToPrevious`, `spawnDeclared`,
  `spawnTool`), or are synchronous. A `message` that is not a string is written
  as `String` writes it (`opm: undefined`), where an earlier version of the
  writer threw.
- **A message with nothing to remove is written byte for byte as before**
  (`apps/opm/test/error-text.test.ts` pins six real single-line ones, and
  `error-lines.test.ts` the lists).

- **Standard output has a writer and a gate, and the other two command lines are
  in them.** `@openpacker/canonical` holds the writers of the command lines.
  `report` is an error for standard error: the message made plain, its line
  feeds kept (moved from `apps/opm` unchanged). `out` is text for standard
  output: escape sequences and control, format and bidirectional characters
  removed, a carriage return a line feed, and the line feeds and tabs a command
  writes itself kept (a listing is columns separated by a tab), so text with
  nothing to remove is written byte for byte. `outJson` is a JSON document: the
  characters a terminal acts on inside a string are written as `\uXXXX`, which
  parses to the same document, and a line feed follows. `outRaw` is what a child
  wrote itself, as it wrote it. The 92 writes to standard output (86 in
  `apps/opm`, 5 in `apps/openpacker-cli`, 1 in the daemon's start) are calls of
  them; the one write left is the script's own stdout in `run-child.ts`, which
  the run path may not import `canonical` for (ADR 0047, `run-load.test.ts`).
  `openpacker` writes its errors through `report` (the human line, and the
  one-line JSON document), and the daemon's start reports why it could not start
  instead of leaving Node to print the stack.
  `apps/opm/test/stdout-writers.test.ts` holds standard output to them with the
  scanner that holds standard error (`stderr-scan.ts`, a function of the
  stream), over the sources of the three apps: any mention of a stdout stream,
  of `console`, of a file descriptor 1, an alias, a destructuring, a bound
  write, a `Console` or a computed key is a use, and every use is named in the
  test with the reason it may be there; 25 fixtures must be caught and 7 must
  not, and every call of `outRaw` is named too. `stderr-writers.test.ts` scans
  the same three apps.

- **A field of the wrong JSON type is a coded refusal, not an internal error.**
  `"schemaVersion": {}` in `opm.lock.json` gave
  `opm: internal error: Cannot convert object to primitive value` on `list`,
  `why`, `install`, `manifest` and `update`: the JSON reader builds objects with
  no prototype, `String()` throws on one (and on an array that holds one), and
  the two messages of `parseLockfile` that repeat `schemaVersion` and
  `generatedBy` called `String()` on the field before `echoed` saw it; `echoed`
  and the OCI client's copy of it called it too. `printable`
  (`@openpacker/canonical`) is the one place that says a value as a template
  literal does (`[object Object]` for an object with no prototype,
  `[object Array]` for an array that holds one), and `echoed`, `echoedValue` and
  the OCI client use it. The second is `opm.toml`: `parseTomlValue` read every
  quoted string and every string in an array with `JSON.parse` and let its
  `SyntaxError` out (`name = "a" "b"`, `ecosystems = ["a" "b"]`, a string with
  an escape JSON does not have, a triple-quoted string), so a cloned
  repository's `opm.toml` made every command that read it say it had a bug; it
  is `Invalid string at line N` with `INVALID_MANIFEST` now. Found by two seeded
  fuzzes in `packages/opm-project/test` (`type-confusion.test.ts` for the lock,
  `type-confusion-manifest.test.ts` for the manifest). The lock fuzz replaces
  each of the 58 paths of a lock that holds every field by each of 17 values of
  another type, removes it, and draws 4,000 seeded combinations of two to four
  edits: on the old sources 6 single edits fail (`schemaVersion` and
  `generatedBy`, each as `{}`, `{"a":1}` and `{"a":{}}`) and no other field. The
  manifest fuzz replaces the value of each of the 56 assignments (11 sections)
  by each of 33 values of another type or shape (1,848 single edits), replaces
  each of the 11 section headers by 20 names the reader does not know, removes
  and doubles every line, and draws 4,000 combinations: on the old sources 224
  of the 1,848 single edits fail, every one a `SyntaxError`, in all 55 distinct
  key names. `apps/opm/test/type-confusion-commands.test.ts` runs `list`, `why`,
  `install --offline`, `sync --offline`, `manifest`, `update --offline`,
  `generations` and `gc` with each of the 22 fields of the lock replaced by
  `null`, `5`, `"x"`, `[]` and `{}` (880 runs) and each of the 7 assignments of
  the manifest by 7 values (392 runs), and requires that none writes
  `opm: internal error`: on the dists before the two fixes the lock fails for
  `schemaVersion` and `generatedBy` as `{}`, and the manifest for `"a" "b"` in
  seven keys (35 runs).

- **Packslip, its adapter, the SDK and `lock-import` word what they quote
  plainly at the source.** 153 interpolations in `packslip` and 47 in
  `adapter-packslip` repeated a project name, an artifact name, a tag, a reason
  for a withdrawal, a signer's identity and repository, a library or command a
  release needs, or a lock's or manifest's key as the vendor, the forge or the
  repository had worded it. `PackslipError` makes its message one line
  (`plainLine`) whatever its call site quoted, and takes the entries of a list
  apart so that each is one line; where a document's text is quoted `shown`
  (`safeEcho`: one line, no escape, control, format or bidirectional character,
  at most 256 characters and how long it was) is the first layer, at 63 sites in
  `packslip` and 17 in `adapter-packslip`. `PrexClientError` and
  `UnsupportedProtocolVersionError` (`@openpacker/sdk`) took the server's
  `detail`, `title` or protocol version raw; the message is `safeEcho` at 512
  characters now, and the problem keeps the document as it was received.
  `lock-import` repeated a `pnpm-lock.yaml` key, a package name and the
  `lockfileVersion`, a `requirements.txt` line and a `uv.lock` version raw; they
  go through `echoedValue`. Tests with a hostile vendor, server or lock: 7 of 7
  in `packslip` and 3 of 6 in `adapter-packslip` fail on the old sources (the
  other three reach a `PackslipError`, which is plain now), the SDK's 3 of 3 and
  `lock-import`'s 13 of 13.

- **What a registry, an installer and a project's directory say in a report is
  plain where it is quoted, and the tests drive it through `runOpm`.**
  `opm search`, `versions` and `info` printed a registry's canonical PURL,
  version, inspected PURL, digest, media type and download address as the
  adapter returned them; each is `plainLine` at the line. `opm resolve`'s list
  of the packages it selected needs none: the resolver refuses an identity whose
  `exactPurl` is not canonical (every one with a raw control or separator in
  it), so what it lists is ASCII already, and a test says so. A host install
  wrote the command it would run, the PURL it installed and the version it
  settled on as they came, and `opm system available` the reason an installer
  could not run and its tool's version; they are plain now. `opm run` and
  `opm exec` quote the project's directory and the `package.json` in it in
  messages that keep their line feeds, so a directory named with a line feed
  started a line of its own; the eight messages (no `package.json`, one that is
  too large, is not JSON or is not an object, `scripts` that are not an object,
  a script that is not there or is not a string, and a bin that is not found)
  quote the path plainly, and the `canonical` package is still loaded only when
  a message needs it (ADR 0047). `runOpm` takes `adapters` beside `fetch`, so
  that a test speaks for a registry, an installer or a project format as a bound
  plugin does; the process entry passes none.
  `apps/opm/test/plain-registry.test.ts` (8 tests), `plain-reports.test.ts` (14)
  and `plain-run.test.ts` (8) run each message with `x` and with the hostile
  text, and hold both streams to the same number of lines, none starting like
  one of opm's and none holding a character a terminal acts on. On the old
  sources 7 of 8, 5 of 14 and 8 of 8 fail; the other 9 of
  `plain-reports.test.ts` pin lines that were plain already (the meaning an
  installer could not keep, what a native projection left out and could not
  keep, the package `opm resolve` could not place and why: 8 of the 9 fail when
  their `plainLine` is taken out) and the passthrough of the installer's own
  stdout. What the person typed (a script name, a bin name, a package spec) is
  the person's and is written as it was.

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
time. A third limit, `maximumCost`, weighs the parts of the tree and replaced
the count for packuments ("A budget that weighs what a tree allocates", below).
Parsing a legitimate 25.6 MB packument costs the same as before (about 1.5 s
either way).

### What one hostile document costs

This section is history: it measures what the limit on a count of values allowed
(4,194,304 values for the abbreviated packument and 6,291,456 for the full one),
and that limit has been replaced by a budget that weighs what a tree allocates
("A budget that weighs what a tree allocates", below). The tables are kept
because they are the shapes that budget was calibrated against, and the figures
in them are what the code before it cost.

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
1 GiB is 1,024 MiB), and it moves between runs of one shape by as much as a
quarter (1,555 and 1,964 MiB for the object of `[]`-valued members, 26 percent;
2,169 and 2,655 MiB for the 12-character one, 22 percent). The runs were made by
different people on different days and loads, on 4 CPUs shared with other work,
so a range is not one machine's spread.

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
| one object of `"<12 characters, each different>":[],` members (18 bytes each) | accepted: 16.7 to 19.6 s, 1,555 to 1,964 MiB (4 runs)             | not tried                                                        |
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
- An array of `[]` (3 bytes a value) is refused like `{},`, after 12 MiB: 2.6 to
  2.8 s, 493 to 524 MiB (three runs). An earlier version of this table gave that
  label to the row above, which is an object of `[]`-valued members and is
  accepted whole.
- The `€` was first thought to make the 12-character object dearer, from a
  single run (2,683 MiB against 2,169 to 2,432 MiB for the object without it).
  The review's runs overlap (2,655 MiB without it, 2,676 and 2,394 MiB with it),
  so the explanation is not shown and is dropped.
- The worst shape is one object with millions of members, each an empty object.
  The tree is dear and so is the time: 6.0 to 15.9 microseconds a member (the
  least is 22.5 s over the 3.7 million members of the 12-character object, the
  most 100 s over the 6.3 million values at which the 7-character one is
  refused), growing a little faster than the size (5.3 microseconds a member at
  250,000 members and 7.9 at 2,000,000, measured separately). The parse is on
  the main thread, so the command is stuck for that long.
- A refusal is not cheap. It comes when the tree has the limit's worth of
  values, wherever that is in the body, so a dense body is refused having built
  as many values as a sparse one is accepted with: the object with 7-character
  keys was refused after 52.2 to 60.8 s, longer than the accepted one with
  12-character keys (22.5 to 30.4 s). Reading less of the body is the only
  saving.
- These figures are a constant of the limits and not of the registry: a larger
  body is refused on bytes before it is parsed.

The lever was the 16 bytes a value, and it was not a cheap one. 32 would have
halved the values allowed and so roughly the worst case, but it would have been
1.1 times the densest real document found (28.8 bytes a value), so a real
document would have been refused for its values before its bytes. What lowers
the cost without refusing a real document is weighing objects and members in the
budget instead of counting every value alike, and that is what the next section
does. A cheaper tree (the parser builds a null-prototype object and a `Set` for
every object and calls `JSON.parse` for every string) is not done.

### A budget that weighs what a tree allocates

A count of values is the wrong measure of a tree. `1,` is two bytes and a slot
in an array; `{},` is three bytes and a dictionary-mode object that takes about
200; and the table above is what the count cost: 64 MiB of one object of
12-character names with an empty object each was 3.7 million values, was
accepted, and took 2.1 to 2.6 GiB, so a client started with
`--max-old-space-size=1024` (rerun for this section: exit 134 after 34 s) or
`1536` died with `FATAL ERROR: Ineffective mark-compacts near heap limit`
instead of refusing it. The parser now charges each part of the tree by what V8
allocates for it, as it begins the part, and stops at the part that would pass a
limit in bytes of heap: `PARSE_COSTS` in `@openpacker/canonical`, `maximumCost`
in `CanonicalParseLimits`, `maximumCost` in `ProviderMetadataLimits`. It still
never counts a finished tree. A refusal is the same `MetadataLimitError`, with
`limit: 'cost'`, `visited` the values begun (the refused part's included),
`spent` the cost charged by then, and the message
`Provider metadata exceeds 536870912 bytes of parsed size`.

**How it was measured.** Node 22.22.0, linux/x64, 4 CPUs shared with other work:
the load average was 4 to 23 over the runs, which is why each figure says
whether it is CPU seconds (the process's own, which move less with load) or wall
seconds, and the load it was taken at. Thirty-eight synthetic documents, each in
its own process on the parser as it was before this change (pieces of the table
above, nested, as arrays and as objects, numbers, `null`, strings of 0 to 64 Ki
characters with and without a `€`, objects of 1 to 1,000 characters of name, and
a `versions` object like a packument's, at about 800,000 pieces), and the 22
real packuments of `packument-survey.ts`; and the time of objects of 20 to
40,000 members and of one object of up to 3,000,000. For each document: what the
finished tree keeps (the heap after a collection less the heap before, with the
tree alive), and the **peak**: the least `--max-old-space-size` under which
`json()` of the document completes (bisected to 3 percent), less the document's
own text (one byte a character, two for a document with one character past
U+00FF) and less 43 MiB, which is what a process of this kind needs for itself.
Each weight below is the smallest that keeps its cost at or above the peak of
every one of those thirty-eight shapes. Shapes measured since ("Shapes found
since", below) include two whose peak is above their cost.

**What it found.**

- An object takes 195 bytes kept in the dictionary mode the parser builds
  (`Object.create(null)`): no more for one member than for none, and 240 at the
  peak, which has the `Set` of names the parser keeps for each object.
- An array takes 40 empty. The first element makes V8 give it room for 17 slots,
  so `[1]` takes 190, and a slot is 8 bytes after that.
- A member costs its dictionary entry and its name, which V8 internalizes: 82
  bytes kept at 800,000 members of one object with a 12-character name, and 168
  at the peak, because the parser's set of names and its validation of the
  finished tree (it encodes the tree again) are alive with it. In small objects
  it is about 40.
- A string is its header and its characters, one byte a character and two for
  text past U+00FF (the `€` in a name or a value makes it two).
- A number in an array is 8 bytes kept, but the peak is not linear in the count
  of them: 36 bytes each at 800,000 numbers and 80 at 8,000,000 (673 MiB). The
  weights first came from the 800,000 size; a document of 13.8 million `1,`
  accepted at that weight ended the process under a 1 GiB heap, and the weight
  is now 90, found by running every shape at the size the limit lets through and
  not at the size it was calibrated at.
- Time is a second constraint. A member costs 1.1 microseconds of CPU in objects
  of up to 40,000 members (2,000,000 members: 2.2 to 2.9 s), but grows with the
  size of one object: 2.6 microseconds a member at 1,000,000 members in one
  object, 6.9 at 2,000,000 and 10.1 at 3,000,000 (13.7 s and 30.2 s of CPU). So
  a member past the 4,096th of its object costs 400 more (`BIG_OBJECT_MEMBERS`,
  `bigMember`): at the limit that allows about 1.1 million of them in one
  object, not 3.7 million. The largest object in any real packument has 28,043
  members.

**The weights**, in bytes. `peak` is what a limit is set in; `retained` is what
a holder that keeps the tree counts it by (below).

| part                                       | peak | retained |
| ------------------------------------------ | ---- | -------- |
| an object                                  | 240  | 195      |
| an array                                   | 64   | 40       |
| the first element of an array              | 150  | 150      |
| each element of an array                   | 90   | 9        |
| each member of an object                   | 60   | 40       |
| each member past the 4,096th of its object | 400  | 45       |
| each character of a member name            | 3.5  | 1        |
| a string value                             | 50   | 24       |
| each character of a string value           | 2    | 1        |
| an integer below -2^30 or from 2^30 on     | 150  | 16       |

Two-byte text (any character past U+00FF, or an escape) is charged twice a
character. An integer in V8's small-integer range, `true`, `false` and `null`
cost only their slot; an integer outside it is an object of its own (a heap
number, below).

**Held against the shapes.** Fifteen of the thirty-eight, at about 800,000
pieces each. `kept` is measured, `estimated` is `PARSE_COSTS.retained`, `peak`
is measured and `cost` is `PARSE_COSTS.peak`; the cost is above the peak of
every one of the thirty-eight (1.28 to 6.2 times), and the estimate is between
0.99 and 1.95 times what was kept, except for empty strings, which share one
string (3.7).

| the document (a repeated piece)                                | pieces  | text MiB | kept MiB | estimated | peak MiB | cost MiB |
| -------------------------------------------------------------- | ------- | -------- | -------- | --------- | -------- | -------- |
| `{},` (3 bytes a value)                                        | 799,201 | 2.3      | 147.0    | 155.5     | 165.7    | 251.5    |
| `1,` (2 bytes a value)                                         | 799,201 | 1.5      | 6.8      | 6.9       | 27.5     | 68.6     |
| `[1],`                                                         | 399,800 | 1.5      | 74.7     | 79.3      | 73.5     | 150.2    |
| `"<14 characters>",`                                           | 799,201 | 13.0     | 31.2     | 35.8      | 74.0     | 128.0    |
| the same, with a `€` in each                                   | 799,201 | 13.0     | 43.4     | 46.5      | 71.1     | 149.4    |
| `"<1,000 characters>",`                                        | 25,090  | 24.0     | 24.7     | 24.7      | 14.0     | 51.2     |
| `{"<26 characters, each different>":1},`                       | 399,800 | 12.6     | 93.1     | 102.9     | 132.4    | 183.4    |
| `{"a":1,"b":2,"c":3,"d":4,"e":"<14 characters>"},`             | 133,311 | 6.0      | 41.2     | 56.8      | 29.0     | 92.2     |
| `{"<26 characters, each different>":{}},`                      | 399,800 | 13.0     | 163.2    | 177.3     | 214.0    | 274.9    |
| `{"a":{"a":{"a":{"a":{}}}}},`                                  | 159,968 | 4.1      | 141.8    | 175.1     | 158.9    | 235.5    |
| one object of `"<12 characters, each different>":{},` members  | 799,201 | 13.7     | 212.8    | 222.4     | 289.3    | 564.0    |
| one object of `"<12 characters, each different>":1,` members   | 799,201 | 13.0     | 72.5     | 73.8      | 128.0    | 381.1    |
| one object of `"<7 characters, each different>":{},` members   | 799,201 | 9.9      | 206.7    | 218.6     | 237.1    | 550.6    |
| one object of `"<26 characters, each different>":1,` members   | 799,201 | 23.6     | 84.7     | 84.4      | 165.4    | 418.4    |
| a `versions` object of 33,331 entries, as a packument has them | 33,331  | 20.9     | 81.0     | 106.6     | 70.1     | 178.7    |

The object of members shows the surcharge: its cost is far above its peak at
this size because a member past the 4,096th is charged for the time it takes and
not for the memory.

**Held against the packuments.** `kept` is measured on the unchanged parser.
`headroom` is the limit over the cost; the estimate is above what was kept for
every one (1.05 to 1.6 times).

| packument                    | document    | MiB  | cost MiB | limit MiB | headroom | estimated kept | kept  | CPU s |
| ---------------------------- | ----------- | ---- | -------- | --------- | -------- | -------------- | ----- | ----- |
| renovate                     | abbreviated | 33.8 | 219.2    | 512       | 2.34     | 111.7          | 72.8  | 2.12  |
| @prisma/client               | abbreviated | 36.4 | 213.4    | 512       | 2.40     | 112.9          | 84.6  | 1.93  |
| @bike4mind/cli               | abbreviated | 26.8 | 165.7    | 512       | 3.09     | 87.5           | 56.1  | 1.60  |
| @wix/wix-code-types          | abbreviated | 25.9 | 163.8    | 512       | 3.13     | 88.4           | 59.7  | 1.54  |
| next                         | abbreviated | 24.4 | 154.5    | 512       | 3.31     | 79.7           | 58.4  | 1.64  |
| public-unscoped-test-package | abbreviated | 36.6 | 139.6    | 512       | 3.67     | 74.5           | 65.2  | 1.09  |
| prisma                       | abbreviated | 22.1 | 130.3    | 512       | 3.93     | 71.0           | 53.9  | 1.20  |
| gatsby                       | abbreviated | 15.0 | 91.8     | 512       | 5.57     | 47.4           | 30.0  | 0.84  |
| @ionic/core                  | abbreviated | 9.7  | 53.6     | 512       | 9.54     | 29.1           | 20.3  | 0.57  |
| typescript                   | abbreviated | 8.3  | 49.8     | 512       | 10.28    | 26.9           | 19.2  | 0.50  |
| firebase                     | abbreviated | 9.4  | 44.4     | 512       | 11.52    | 23.5           | 19.0  | 0.52  |
| playwright-core              | abbreviated | 8.0  | 39.6     | 512       | 12.94    | 22.6           | 18.5  | 0.41  |
| vite                         | abbreviated | 2.2  | 15.0     | 512       | 34.21    | 8.4            | 6.2   | 0.21  |
| @wix/wix-code-types          | full        | 73.0 | 561.5    | 720       | 1.28     | 318.0          | 230.0 | 4.21  |
| renovate                     | full        | 68.7 | 483.3    | 720       | 1.49     | 253.2          | 182.8 | 4.28  |
| @prisma/client               | full        | 65.4 | 426.1    | 720       | 1.69     | 227.0          | 171.1 | 3.68  |
| sanity                       | full        | 48.0 | 396.0    | 720       | 1.82     | 220.4          | 154.3 | 3.37  |
| public-unscoped-test-package | full        | 59.2 | 337.8    | 720       | 2.13     | 190.0          | 150.3 | 3.04  |
| next                         | full        | 30.0 | 199.4    | 720       | 3.61     | 105.2          | 78.5  | 1.97  |
| vite                         | full        | 37.2 | 156.0    | 720       | 4.62     | 79.8           | 76.3  | 1.66  |
| @material/list               | full        | 58.8 | 143.4    | 720       | 5.02     | 74.6           | 69.3  | 1.09  |
| typescript                   | full        | 15.1 | 102.9    | 720       | 6.99     | 57.5           | 43.1  | 1.05  |

The abbreviated one nearest its limit is `renovate`, 2.34 times under; a
document of its composition at the 64 MiB byte bound would cost 415 MiB, so for
a packument shaped like a real one the bytes are still what stops it. The full
one nearest is `@wix/wix-code-types`, 1.28 times under, which is 93.6 MiB before
the 96 MiB byte bound; `renovate`'s full document reaches 96 MiB first (at
1.49). These are the costs before an object's member table was charged; with it,
`renovate`'s abbreviated document is 1.97 times under and `@wix/wix-code-types`'
full one 1.20 ("The member table charged").

**The limits.** 512 MiB for the abbreviated packument and 720 MiB for the full
one. The heap they leave is the other constraint: the worst document accepted is
the limit in cost and, when it has one character past U+00FF, two bytes a
character of text in the heap as well, 128 MiB for the 64 MiB bound and 192 MiB
for the 96 MiB one, and 43 MiB for the process. That is 683 MiB and 955 MiB
against 1 GiB. 768 MiB for the full packument would have left 2 percent of the
heap; 720 leaves 7 percent, and 1.28 times `@wix/wix-code-types`. The slowest
document accepted takes 13.2 s of CPU, at the full limit. That arithmetic
assumes the cost is at least the peak, which the objects of a few dozen members
found since are not: their peak at the full limit was 862 MiB, and with their
text and the process 1,043 MiB; since the parse stopped encoding the tree again,
744 and 925 MiB. With their member tables charged they are again: the heaviest
of that shape the limit lets through needs a heap of 496 MiB ("The member table
charged").

**Held against the worst a hostile registry can send.** For each shape, a
document at 0.95 of the limit (or at the byte bound, if that comes first) must
be accepted inside `--max-old-space-size=1024`, and one at 1.06 of the limit
refused; every one of the 39 documents made at 1.06 was refused, and no document
at 0.95 ended the process. (Five single-object shapes are not in the first run
of each table: the sample that sized them did not yet count the surcharge for a
member past the 4,096th, so they were refused at the size meant to be accepted;
they are rows of both tables, sized again with the surcharge counted.)
`peak heap` is the largest heap size V8 reported before a collection
(`--trace-gc`), garbage included; `peak RSS` is `ru_maxrss`. The two heaviest of
the full table were also read inside 900 MiB.

The abbreviated limit (512 MiB, a 64 MiB body; the slowest took 8.7 s of CPU and
10.4 s of wall at a load of 12):

| the document (a repeated piece)                               | text MiB | cost MiB | peak heap MiB | peak RSS MiB | CPU s | wall s | load |
| ------------------------------------------------------------- | -------- | -------- | ------------- | ------------ | ----- | ------ | ---- |
| `1,`                                                          | 10.8     | 486      | 505.5         | 278          | 1.57  | 2.09   | 4.5  |
| `"<14 characters>",`                                          | 49.2     | 486      | 557.6         | 807          | 2.66  | 3.99   | 8.3  |
| `"€<13 characters>",`                                         | 42.2     | 486      | 529.2         | 710          | 3.51  | 4.82   | 11.0 |
| `"<100 characters>",`                                         | 64.0     | 211      | 308           | 471          | 1.27  | 1.68   | 10.4 |
| `[1],`                                                        | 4.9      | 486      | 414.2         | 449          | 2.19  | 2.41   | 13.2 |
| `{},`                                                         | 4.4      | 486      | 466.1         | 566          | 2.31  | 3.08   | 12.7 |
| `{"<26 characters, each different>":1},`                      | 33.4     | 486      | 520           | 636          | 5.13  | 5.57   | 13.2 |
| `{"<26 characters, each different>":{}},`                     | 22.9     | 486      | 496.9         | 612          | 4.42  | 5.83   | 12.4 |
| objects of 500 members, 3-character names                     | 54.7     | 486      | 521.9         | 600          | 8.19  | 9.11   | 12.1 |
| objects of 4,000 members, 3-character names                   | 55.1     | 486      | 515.6         | 607          | 8.7   | 10.35  | 12.4 |
| one object of `"<12 characters, each different>":{},` members | 12.3     | 486      | 384           | 493          | 4.46  | 6.25   | 12.5 |
| one object of `"<12 characters, each different>":1,` members  | 16.6     | 486      | 255.6         | 373          | 3.65  | 4.49   | 12.6 |
| one object of `"<7 characters, each different>":1,` members   | 12.1     | 486      | 203           | 310          | 3.17  | 3.5    | 10.9 |
| one object of `"<26 characters, each different>":1,` members  | 27.5     | 486      | 285           | 506          | 3.26  | 4.27   | 10.7 |
| one object of `"€<10 characters>":{},` members                | 11.1     | 486      | 354.8         | 454          | 4.4   | 6.49   | 12.7 |
| a `versions` object, as a packument has them                  | 57.9     | 486      | 427           | 518          | 5.22  | 6.28   | 12.7 |
| one object of 100-character names                             | 64.0     | 474      | 362.8         | 522          | 3.4   | 4.27   | 12.5 |

The full limit (720 MiB, a 96 MiB body; the slowest took 12.8 s of CPU and 18.7
s of wall at a load of 16, and 13.2 s and 12.6 s at a load of 4):

| the document (a repeated piece)                               | text MiB | cost MiB | peak heap MiB | peak RSS MiB | CPU s | wall s | load |
| ------------------------------------------------------------- | -------- | -------- | ------------- | ------------ | ----- | ------ | ---- |
| `1,`                                                          | 15.2     | 684      | 697.4         | 358          | 2.12  | 2.3    | 4.6  |
| `"<14 characters>",`                                          | 69.2     | 684      | 793           | 1021         | 3.55  | 3.88   | 5.0  |
| `"€<13 characters>",`                                         | 59.3     | 684      | 753.3         | 1017         | 4.79  | 4.73   | 6.2  |
| `"<100 characters>",`                                         | 96.0     | 317      | 465.2         | 668          | 1.88  | 1.82   | 6.3  |
| `[1],`                                                        | 6.9      | 684      | 568.6         | 611          | 3.05  | 2.87   | 6.0  |
| `{},`                                                         | 6.2      | 684      | 633.2         | 743          | 3.37  | 3.3    | 6.2  |
| `{"<26 characters, each different>":1},`                      | 46.9     | 684      | 802.4         | 956          | 6.31  | 7.33   | 7.2  |
| `{"<26 characters, each different>":{}},`                     | 32.3     | 684      | 795.6         | 921          | 5.47  | 6.65   | 10.3 |
| objects of 500 members, 3-character names                     | 76.9     | 684      | 711.2         | 810          | 11.41 | 15.33  | 12.2 |
| objects of 4,000 members, 3-character names                   | 77.5     | 684      | 718.7         | 819          | 12.83 | 18.74  | 16.0 |
| one object of `"<12 characters, each different>":{},` members | 17.4     | 684      | 475.9         | 588          | 6.02  | 7.59   | 16.2 |
| one object of `"<12 characters, each different>":1,` members  | 23.3     | 684      | 388.6         | 536          | 5.74  | 6.51   | 10.4 |
| one object of `"<7 characters, each different>":1,` members   | 17.0     | 684      | 309.6         | 461          | 8.32  | 11.32  | 11.3 |
| one object of `"<26 characters, each different>":1,` members  | 38.7     | 684      | 405           | 654          | 5.05  | 4.73   | 11.7 |
| one object of `"€<10 characters>":{},` members                | 15.6     | 684      | 492.1         | 606          | 6.71  | 7.78   | 17.6 |
| a `versions` object, as a packument has them                  | 81.4     | 684      | 600           | 697          | 7.88  | 9.83   | 17.7 |
| one object of 100-character names                             | 92.4     | 684      | 532.3         | 730          | 4.88  | 5.24   | 16.7 |

**Shapes found since.** A review of this change ran thirty-eight more shapes,
and two kinds the weights were not fitted on appeared to need more than their
cost or to keep more than their estimate: large integers, and documents with one
character past U+00FF. Measuring those again found a third. Each row is one
shape at the size the full limit lets through (0.97 of 720 MiB), in ASCII and
with one `€` in the document, on the parser with the heap-number weight, each
run in its own process: `least heap` is the least `--max-old-space-size` under
which the parse completes (bisected to 2 percent), `peak` that less the text
(two bytes a character with the `€`) and 43 MiB, and the last two columns a run
at 1 GiB. Node 22.22.0, linux/x64, a load of 12 to 27, so CPU seconds and not
wall.

| the document (a repeated piece)                     | text MiB | cost MiB | least heap MiB (ASCII / `€`) | peak MiB  | peak / cost | peak RSS MiB at 1 GiB | CPU s       |
| --------------------------------------------------- | -------- | -------- | ---------------------------- | --------- | ----------- | --------------------- | ----------- |
| an object of 26 one-character names, `1073741824`   | 46.6     | 698      | 350 / 415                    | 260 / 279 | 0.37 / 0.40 | 576 / 673             | 3.9 / 4.4   |
| `{"a":9007199254740991,"b":…,"c":…}`                | 47.5     | 698      | 350 / 434                    | 260 / 296 | 0.37 / 0.42 | 606 / 719             | 4.3 / 4.5   |
| `{"a":9007199254740991}`                            | 29.6     | 698      | 537 / 565                    | 464 / 463 | 0.67 / 0.66 | 785 / 791             | 4.8 / 4.8   |
| `9007199254740991,`                                 | 49.5     | 698      | 241 / 293                    | 149 / 151 | 0.21 / 0.22 | 507 / 607             | 2.3 / 2.5   |
| `"<12 digits>",`                                    | 63.9     | 698      | 481 / 546                    | 374 / 375 | 0.54 / 0.54 | 853 / 933             | 5.3 / 5.4   |
| an object of 22 two-character names, each `1`       | 60.4     | 698      | 837 / 912                    | 734 / 748 | 1.05 / 1.07 | 1,093 / 1,211         | 11.3 / 11.6 |
| an object of 86 two-character names, each `1`       | 69.2     | 698      | 931 / 1,043                  | 819 / 862 | 1.17 / 1.23 | 1,220 / 1,359         | 13.5 / 14.6 |
| an object of 22 names, each a different large value | 66.5     | 698      | 434 / 509                    | 324 / 333 | 0.46 / 0.48 | 727 / 857             | 5.6 / 5.8   |

- **Large integers.** An integer past V8's small integers (from 2^30 on a build
  with pointer compression, 2^31 on Node's own) is an object of its own. Kept,
  it is 16 bytes more in an object (211.9 bytes against 195.9 for an object of
  one such member) and nothing more in an array, where V8 stores doubles in
  place. At the peak it was 146 bytes a number in objects of one member (1.5
  million of them, 520 against 311 MiB), 56 in objects of three and 33 in an
  array: what the check that encodes the tree again writes of its digits. It is
  now charged as a heap number (`heapNumber`, 150 at the peak and 16 kept, from
  -2^30 and from 2^30 so that a build with pointer compression is covered). The
  review's objects of 26 members of `1073741824` were not short of their cost
  for that reason: on Node's own build that integer is a small one, and what
  they hold is the third finding below.
- **A document with one character past U+00FF.** V8 holds such a document's text
  at two bytes a character, which the arithmetic of the limits already counts.
  It does not hold the strings parsed from it that way: 400,000 strings of 12
  ASCII characters keep 43.8 bytes each in either document, with the text
  decoded as the provider decodes it, and 2 million of them need 218 and 248 MiB
  of heap, the difference being the text (28.6 MiB more) and 1.4 MiB. The 0.78
  the review measured came from building the text as a cons string, which V8
  flattens into a two-byte copy during the parse. What the parse needs beyond
  the text is up to 43 MiB more (0.6 bytes a character, the two-byte output of
  the check that encodes the tree again): the difference of the two columns of
  `peak` above. Strings are therefore not charged twice for being in such a
  document. Doing so would charge `@wix/wix-code-types`' full packument, which
  has 4,687 characters past U+00FF, 708 of its 720 MiB (1.02 times), and
  `renovate`'s 629 (1.15 times), for no memory either holds.
- **Objects of a few dozen members.** V8 gives an object made with
  `Object.create(null)` a dictionary of a power of two of entries, of 24 bytes
  each, at least one and a half times its members (4 entries for up to three
  members, 16 for 6 to 11, 32 for 12 to 21, 64 for 22 to 43, 256 for 86 to 171),
  so an object just past a step holds nearly three entries a member, where the
  member weight allows two and a half. Objects of 22 and 86 members with
  two-character names are the only shapes measured that need more than their
  cost, up to 1.23 times, and they keep up to 1.64 times the estimate (6,245
  bytes an object of 86 members against 3,816). The heaviest, 86 members with a
  `€`, needs a heap of 1,022 to 1,043 MiB in the bisection and completed in all
  five runs at 1,024 MiB (1,351 to 1,362 MiB of RSS, 13.6 to 14.6 s of CPU), and
  at 0.999 of the limit in one more: inside the 1 GiB the limit is set for, with
  nothing to spare. At the abbreviated limit (512 MiB, 64 MiB) every row above
  was accepted inside 1 GiB, at most at 981 MiB of RSS and 8.9 s of CPU (the
  same shape). What was done about it since is the next section.

**Since: the re-encode taken out, and the member table measured.**

- **The parse no longer encodes the tree it built** (`parse-once.test.ts`). Each
  check that encoding made, the parser makes as it builds each part (a lone
  surrogate in any string or name, a number that is not a safe integer or is -0,
  a duplicate name, an object that is not plain), and a parse cannot build a
  cycle or a sparse array. Shown before it was taken out: the canonical and
  `adapter-npm` suites, with the call instrumented, made 74 and 171 parses and
  the call refused none; 200,000 seeded random documents (escaped and lone
  surrogates, -0, 2^53, `1e2`, `1e-400`, fractions, `__proto__`, duplicate
  names, truncations), 133,836 accepted and 66,164 refused, give the same
  outcome with and without it (the digest of every canonical encoding and every
  error's name and message is the same); so do the 38 calibration shapes in
  ASCII and with a `€` (76 documents) and the 22 real packuments. At the same
  document, the least heap fell from 928 to 850 MiB (86 members, ASCII), 993 to
  925 (86 members, `€`), 840 to 712 (22 members, ASCII), 906 to 775 (22 members,
  `€`), 462 to 385 (`@wix/wix-code-types`, full) and 473 to 331 (`renovate`,
  full). The objects of 22 members now need 0.87 of their cost at the full
  limit; those of 86 members still need 1.06 (the first bisection of the `€`
  document gave 1,022 to 1,043 MiB and this one 993: a bisection moves by up to
  5 percent between runs). The weights were not lowered, so every other shape is
  further above its peak than before.
- **The 38 calibration shapes measured again** on this parser, each at the size
  of the table above (800,000 pieces, or 24 MiB of text for long strings; the
  shapes written again from the description above, the first script not having
  been kept): every one needs at most 0.60 of its cost (objects nested five
  deep, 708 MiB of peak for 1,178 of cost), and most under half.
- **The member table.** The model is `member-table.ts`, held against what an
  object of 0 to 128 members kept (`canonical/test/member-tables.json`): 4
  entries for 0 to 3 members, 8 for 4 and 5, 16 for 6 to 11, 32 for 12 to 21, 64
  for 22 to 43, 128 for 44 to 85 and 256 for 86 to 128, 24 bytes an entry, at
  all 129 counts. Charged at its size, crediting what an object's weight pays
  (the empty table) and what a member's pays (16 of its 40 retained bytes, the
  rest being its name's header when the name is its own), the objects of 86 and
  22 members at the full limit are 68,034 and 253,224 of them, need a heap of
  468 and 454 MiB (496 and 496 with a `€`), and so 0.55 and 0.53 of their cost
  (0.54 and 0.54). The 22 real packuments were read again on 2026-10-17 with the
  member count of every object (`packument-survey-objects.json`), and the same
  charge takes `@wix/wix-code-types`' full packument from 561.9 to 598.3 MiB:
  the limit 1.20 times what it needs, 83.1 percent of it used, past the four
  fifths the headroom rule allows. `renovate`'s full packument goes from 486.3
  to 540.6 MiB (1.33 times, 75.1 percent). Crediting a member more moves
  `@wix/wix-code-types` to 588.7 MiB (24 a member, 1.22 times), 574.5 (36, 1.25
  times, 79.8 percent) and 569.8 (all 40, 1.26 times, 79.1 percent); crediting
  nothing, to 617.8 (1.17 times). At a credit of 40 the objects of 86 and 22
  members would need about 0.68 and 0.65 of their cost, but the estimate of what
  an object keeps would be under it for objects whose names are their own. What
  the two documents need is far below any of these costs: at the peak, 196 MiB
  for `@wix/wix-code-types` (a least heap of 385 MiB, less 146 MiB of two-byte
  text and 43) and 150 MiB for `renovate`. The charge was made at a credit of
  16, and the limits kept, with the headroom rule widened to 85 percent (next
  section).

**The member table charged (decided 2026-10-17).** The estimate may not be below
the measured peak for any shape, and without the charge the objects of 86
members need 1.06 times their cost, so the table is charged at the credit the
model gives, 16 bytes a member.

- **What is charged.** As each member is added, the parser charges what the
  object's member table grows by beyond what the weights already pay
  (`budget.ts`, `member-table.ts`). For `n` members the table has
  `max(4, pow2ceil(n + floor(n / 2)))` entries of 24 bytes. The object's weight
  pays for the 4 entries of an empty table, and each member's weight pays 16
  bytes of it (61 past the 4,096th member, with the surcharge). An object
  therefore costs `24 × (entries − 4) − 16 × n` more, when that is above 0. The
  charge falls back between steps, as the members' own weights catch up with the
  table. Measured with `Object.create(null)` on Node 22.22.0, 10,000 objects a
  count (`member-tables.json`):

  | members   | entries | bytes an object kept, at the first and last count |
  | --------- | ------- | ------------------------------------------------- |
  | 0 to 3    | 4       | 195 and 188.5                                     |
  | 4 and 5   | 8       | 290.1 and 288.2                                   |
  | 6 to 11   | 16      | 480 and 478.5                                     |
  | 12 to 21  | 32      | 864.1 and 864.4                                   |
  | 22 to 43  | 64      | 1,635.1 and 1,630.3                               |
  | 44 to 85  | 128     | 3,169.9 and 3,166.5                               |
  | 86 to 128 | 256     | 6,241.7 and 6,238.5                               |

  Each step adds 24 bytes an entry, within 12: 96, 192, 384, 768, 1,536 and
  3,072.

- **The two shapes that needed more than their cost.** Each document is sized to
  0.97 of the full limit (698.4 MiB of cost). The least heap comes from a
  bisection, in ASCII and with one `€`:

  | document                                      | objects | least heap MiB | peak / cost |
  | --------------------------------------------- | ------- | -------------- | ----------- |
  | 86 members, the parse encoding the tree again | 120,210 | 928 / 993      | 1.17 / 1.16 |
  | 86 members, not encoding it                   | 120,210 | 850 / 925      | 1.06 / 1.06 |
  | 86 members, the table charged                 | 68,034  | 457 / 496      | 0.54 / 0.54 |
  | 22 members, the parse encoding the tree again | 405,945 | 840 / 906      | 1.05 / 1.06 |
  | 22 members, not encoding it                   | 405,945 | 712 / 775      | 0.87 / 0.87 |
  | 22 members, the table charged                 | 253,224 | 457 / 496      | 0.54 / 0.54 |

  The charged parser refuses the documents of 120,210 and 405,945 objects, which
  now cost 1,234 and 1,120 MiB (`CanonicalJsonLimitError`, ASCII and `€`). Every
  one of the 38 calibration shapes needed at most 0.60 of its cost, and the
  charge only adds to a cost. The cost is therefore at least the peak for each
  of the 38 shapes. None of them names a member by an array index, which V8
  keeps outside the member table; such a member is charged apart ("A member
  named by an array index").

- **The real packuments.** Each cost is by composition, with the tables charged
  from `packument-survey-objects.json`, in MiB and as a share of the limit:

  | packument                    | document    | before | charged | share | limit / cost |
  | ---------------------------- | ----------- | ------ | ------- | ----- | ------------ |
  | @wix/wix-code-types          | full        | 561.6  | 598.0   | 83.1% | 1.20         |
  | renovate                     | full        | 486.1  | 540.4   | 75.1% | 1.33         |
  | @prisma/client               | full        | 426.1  | 472.1   | 65.6% | 1.52         |
  | sanity                       | full        | 396.7  | 426.3   | 59.2% | 1.69         |
  | renovate                     | abbreviated | 220.8  | 259.5   | 50.7% | 1.97         |
  | public-unscoped-test-package | full        | 337.8  | 353.3   | 49.1% | 2.04         |
  | @prisma/client               | abbreviated | 213.4  | 245.1   | 47.9% | 2.09         |

  The other fifteen need at most 40.5 percent. Read by the parser,
  `@wix/wix-code-types`' full packument costs 598.3 MiB. Other credits were
  tried on that document and not chosen:

  | credit a member | cost MiB | limit / cost | share |
  | --------------- | -------- | ------------ | ----- |
  | 0               | 617.8    | 1.17         | 85.8% |
  | 24              | 588.7    | 1.22         | 81.8% |
  | 36              | 574.5    | 1.25         | 79.8% |
  | 40              | 569.8    | 1.26         | 79.1% |

  A credit of 40 would put the estimate of what an object keeps below what it
  kept, for objects whose names are their own.

- **The limit or the rule.** Two options were weighed: raise the full limit to
  768 MiB, if that kept the same margin, or keep 720 MiB and widen the headroom
  rule.
  - The full limit is what a heap of 1 GiB leaves after the worst document
    accepted. That is the limit in cost, plus 192 MiB of two-byte text at the 96
    MiB bound, plus 43 MiB for the process.
  - At 720 MiB that leaves 69 MiB, 7 percent of the heap. At 768 MiB it would
    leave 21 MiB, 2 percent. That is not the same margin, so the limit stays at
    720 MiB.
  - The headroom rule goes instead from four fifths of the limit to 85 percent
    (`HEADROOM` in `packument-headroom.test.ts`).
  - Why: the largest known real packument, `@wix/wix-code-types` in full,
    estimates at 83.1 percent of its limit, while its parse needs 196 MiB at the
    peak. The estimate is now at least the peak for each of the 38 shapes and
    the real packuments, and the rule holds the estimate, not the real need.
  - In the same shape, that document would reach 85 percent of the limit at 74.7
    MiB and the limit at 87.8 MiB, both before the 96 MiB byte bound.
  - The abbreviated limit is unchanged. `renovate`'s abbreviated packument is
    1.97 times under it, and a document of its composition at the 64 MiB byte
    bound would cost 487 MiB: the byte bound is still what stops a real one.

**A member named by an array index (decided 2026-10-17).** The review of the
pushed parse found that `{"1023":0,"2575":0}` keeps 31,234 bytes at a charged
cost of 478, 65 times its cost: a packument of 674 KB, 3 percent of the
abbreviated limit, ended a process under `--max-old-space-size=1024` with exit
134, and at the limit the same document would need about 34 GB (abbreviated) or
47 GB (full). The parser charged such a member as any other. It is not any
other: V8 keeps a name that is an array index as an element, not as a property,
so it is not in the object's member table, and the elements store the first one
makes is far larger than the table the object is charged for.

- **The rule, as modelled and measured.** A name is an index when it is `0` or a
  decimal with no sign, no leading zero and no more than 4,294,967,294
  (`isArrayIndex`; an escaped name such as `1` is the name it spells). V8 gives
  an object's elements `(i + 1) + (i + 1) / 2 + 16` slots of 8 bytes for an
  index `i` less than 1,024 past the end of the store, and a store of more than
  5,000 slots (500 in the old generation) stays a fast array only while its
  capacity is under about 27 slots a member; past that it becomes a dictionary
  of three words a member. This is V8's rule as modelled here and checked
  against the measurements below, not a constant of Node. The parser sets
  `result[key] = value` one member at a time, so it gets the store that rule
  gives, where V8's own `JSON.parse` sizes it exactly (208 bytes for
  `{"1023":0,"2575":0}`). That is why the readers that call `JSON.parse`
  directly (cargo, Go) are unaffected.
- **What is charged** (`member-table.ts`, `budget.ts`). `FIRST_INDEX_MEMBER`,
  40,016 bytes (5,000 slots and a header), once for an object, on its first
  index-named member; `INDEX_MEMBER`, 216 bytes (27 slots), for every
  index-named member. Both go to the peak and to the retained estimate. They are
  an upper bound on purpose: the worst kept past the flat 40,016 was 118 bytes a
  member (names 16 apart, 4,096 of them), against 216.
- **What was kept** (`elements.json`, `elements.test.ts`), bytes an object of
  such names kept after a collection, on Node 22.22.0 (V8 12.4); Node 20.20.0
  and 21.7.3 (V8 11.3 and 11.8) measured within 1 percent of these for every
  store past 1 KB and at most 12 percent above for an object of one member. Node
  24 was not available to measure here. The retained estimate and the cost, as a
  multiple of what was kept:

  | names                             | members | kept      | retained / kept | cost / kept |
  | --------------------------------- | ------- | --------- | --------------- | ----------- |
  | `"0"`                             | 1       | 336       | 120.5           | 120.9       |
  | `"1023"`                          | 1       | 12,616    | 3.21            | 3.22        |
  | `"1000000"` (dictionary elements) | 1       | 400       | 101.2           | 101.6       |
  | `"1023"`, `"2575"`                | 2       | 31,240    | 1.30            | 1.31        |
  | 0, 1040, 2600                     | 3       | 31,342    | 1.31            | 1.31        |
  | every 9th to 21,846               | 21,846  | 2,276,340 | 3.06            | 6.15        |
  | every 16th to 4,096 members       | 4,096   | 525,097   | 2.36            | 2.61        |
  | every 1,000th, 1,000 members      | 1,000   | 49,456    | 6.78            | 7.48        |

  The least of the 26 measured rows is 1.30 (retained) and 1.31 (cost), two
  members under 5,000 slots; the greatest is 120 for an object of one member,
  which the flat allowance over-counts as it must. A resolve that holds such
  trees therefore counts at least 1.30 times what they keep, where for the
  objects of 86 members it counted 1.64 times too few.

- **At the byte bound, in a child.** Three kinds of document (an array of
  `{"1023":0}`, of `{"1023":0,"2575":0}` and of `{"0":0,"1040":0,"2600":0}`) are
  built to the 64 MiB and the 96 MiB bound and read by `json()` under
  `--max-old-space-size=1024`. Each is refused at the limit, with
  `Provider metadata exceeds 536870912 bytes of parsed size` (abbreviated) or
  `754974720` (full), in 4.6 to 8.3 s; before the charge all six ended the
  process with SIGABRT (`apps/opm/test/index-names.test.ts`, which requires
  status 3 and no signal).
- **At 0.97 of the limit.** The same kinds, and a two-byte one, sized to 0.97 of
  each limit are accepted, and the least heap that reads them, bisected to 2
  percent with the real provider, is:

  | document        | abbreviated | full    |
  | --------------- | ----------- | ------- |
  | `idx1`          | 175 MiB     | 240 MiB |
  | `idx2`          | 404 MiB     | 568 MiB |
  | two-byte `idx2` | 404 MiB     | 568 MiB |
  | `idxObj`        | 416 MiB     | 568 MiB |

  The cost (496.6 and 698.4 MiB) is above the need by 1.2 to 2.9 times, and the
  heaviest need is 55.5 percent of a 1 GiB heap, with the text and the process.

- **The hostile set**, the review's 44 kinds at each limit, each sized to 0.97
  of the limit and read through the real provider in a 1 GiB heap: all 88 exited
  0, 74 accepted and 14 refused by `MetadataLimitError` or `ProviderError`, none
  ended by the heap. The largest peak RSS was 751 MiB (the full two-byte
  `idx2`).
- **The 38 shapes, again.** None names an index, so no cost moved. The least
  heap of each, bisected again on the charged parser, is within 12 MiB of the
  run before (the bisection's step), and the greatest peak over cost is 0.61
  (`"€<999 characters>"`), where it was 0.60.
- **The real packuments, read live on 2026-10-17.** None of the 22 surveyed
  names a member by an index, so the charge is zero for them and the headroom is
  as it was: `@wix/wix-code-types` full, 618,254 objects, 598.3 MiB of 720 (83.1
  percent); `renovate` full, 540.8 MiB (75.1 percent); `next` abbreviated, 184.1
  MiB of 512 (35.9 percent).
- **Every registry document has a cost limit** (`metadata-json.ts`). `json()`
  and `jsonWithCost()` took a cost limit only from a caller that named one, so a
  document read by a provider that did not had the 200,000 value count and
  nothing else (the cargo and Go readers call `JSON.parse` on a byte-bounded
  body, which sizes an object's elements exactly, and are not affected). They
  now apply `DEFAULT_METADATA_PARSE_COST`, 256 MiB, to a call with no
  `maximumCost`. The 66,600-object document above is refused there with
  `Provider metadata exceeds 268435456 bytes of parsed size`, where it ended a 1
  GiB child before; 66,000 objects `{"a":1}` are read whole, and 200,000 values
  are still refused for their count (`metadata-json.test.ts`). The packument
  limits are unchanged, at 512 and 720 MiB.
- **Not done: the documents with no limit at all.** Several reads of a network
  body call `parseCanonicalJson` and not a costed parse: the packslip discovery,
  verification and resolve payloads and the packslip provider's, the SDK's event
  lines, the bodies of requests to `openpackerd` and `openpacker-registry`, and
  the `opm-project` publish client's receipt. The charge is in the parser, so a
  cost is counted for them, but none is limited. Each needs its own limit, and
  what it should be depends on what that document is for. They are the same
  fault in other readers and are not changed here.
- **Not done: making V8 give the store back.** Deleting the largest index of an
  object after setting it might shrink the store. The charge does not rely on a
  behaviour of V8 that the parse cannot see.
- **Also in this round.** A user name and a password before a host with no
  scheme (`user:secret@host`) are withheld by the redactor as one with a scheme
  already was (`USERINFO` in `redact-text.ts`; `redact-text.userinfo.test.ts`
  and, through a workspace lock's refusal, `lock-tree.userinfo.test.ts`, each
  with both spellings on one line).

**The shapes of the table above, end to end.** The same loopback server and the
repository's own `BoundedFetchTransport` and `NpmRegistryProvider`, every body
exactly the size of its bound, on the final build. All thirty-two (sixteen
shapes, two bounds) are refused by the cost limit (none was accepted whole, as
eight of the 64 MiB column of the first table were), in 2.3 to 6.2 s and 424 to
868 MiB of peak RSS of the client; the first table's took up to 100 s and 3.9
GiB.

| the document's values                          | 64 MiB, abbreviated                  | 96 MiB, full                         |
| ---------------------------------------------- | ------------------------------------ | ------------------------------------ |
| `{},`                                          | refused after 5 MiB: 2.5 s, 616 MiB  | refused after 7 MiB: 4 s, 868 MiB    |
| `1,`                                           | refused after 11 MiB: 3.4 s, 424 MiB | refused after 16 MiB: 5.6 s, 606 MiB |
| `[],`                                          | refused after 10 MiB: 2.3 s, 479 MiB | refused after 14 MiB: 3.8 s, 699 MiB |
| `{"aaaaaaaaaaaaaaaaaaaaaaaaaa":1},` (one name) | refused after 35 MiB: 2.5 s, 560 MiB | refused after 49 MiB: 2.7 s, 666 MiB |
| `{"<26 characters, each different>":1},`       | refused after 35 MiB: 3.1 s, 576 MiB | refused after 49 MiB: 4.4 s, 797 MiB |
| `{"<20 characters, each different>":1},`       | refused after 30 MiB: 3.5 s, 563 MiB | refused after 42 MiB: 4.7 s, 790 MiB |
| `"<14 characters>",`                           | refused after 52 MiB: 3 s, 472 MiB   | refused after 73 MiB: 4.6 s, 679 MiB |
| `{"<26 characters, each different>":{}},`      | refused after 24 MiB: 2.6 s, 607 MiB | refused after 34 MiB: 3.6 s, 786 MiB |
| `{"<20 characters, each different>":{}},`      | refused after 20 MiB: 2.6 s, 632 MiB | refused after 29 MiB: 3.8 s, 848 MiB |
| one object of `"<12 characters>":[],` members  | refused after 16 MiB: 3.4 s, 474 MiB | refused after 23 MiB: 5.2 s, 652 MiB |
| one object of `"<10 characters>":{},` members  | refused after 11 MiB: 3.5 s, 525 MiB | refused after 16 MiB: 5.3 s, 685 MiB |
| one object of `"<12 characters>":{},` members  | refused after 12 MiB: 3.2 s, 572 MiB | refused after 18 MiB: 4.7 s, 742 MiB |
| the same, with one `€` in the name             | refused after 12 MiB: 3.5 s, 631 MiB | refused after 18 MiB: 5.2 s, 829 MiB |
| an object of `"<11 characters>€":{},` members  | refused after 12 MiB: 3.3 s, 541 MiB | refused after 17 MiB: 5.3 s, 806 MiB |
| one object of `"<7 characters>":{},` members   | refused after 9 MiB: 3.7 s, 572 MiB  | refused after 13 MiB: 6.2 s, 751 MiB |
| the same, with one `€` in the name             | refused after 9 MiB: 3.2 s, 598 MiB  | refused after 13 MiB: 5.2 s, 827 MiB |

**What the tests hold.** `canonical/test/parse-costs.test.ts`: the arithmetic of
the table, that a limit stops the parse at the part that would pass it and says
where, and that the same logical document in a heavier encoding (a record as a
bare pair, as an object, with long names, with a `€`) costs more and is refused
earlier. `adapter-core/src/parse-calibration.test.ts` re-measures twelve of the
shapes on whatever Node runs the tests: the estimate must be within 10 percent
below and 2.5 times above what the tree keeps.
`adapter-npm/src/packument-headroom.test.ts` holds the real packuments to 85
percent of their limit (four fifths before the member table was charged), from
the compositions in `packument-survey.ts` and their member counts, checks that
the arithmetic it uses is the parser's, and reads every packument kept in the
repository under both limits. `adapter-npm/src/packument-hostile.test.ts` is the
stop at the limit for `{},` and `1,` at exactly 64 MiB and for the object of
members that used to be accepted. `apps/opm/test/hostile-packument.test.ts` runs
that document and the heaviest accepted one in a child process started with
`--max-old-space-size=1024`, through the lock step: the first is a refusal
(`opm: The packument of hostile is not usable: Provider metadata exceeds 536870912 bytes of parsed size`,
exit 9, the code a registry's unusable document has always had) where the build
before it exits 134, and the second is read whole. Pinned numbers changed as
follows: the `4194304` of `packument-hostile.test.ts` and
`packument-limits.test.ts` are the cost limit and its message;
`visited: limit + 1` is `spent` within one part of the limit; the test that the
limit is a value for every 16 bytes of the bound is gone with that limit; and
`MemoizingTransport.TOTAL_LIMIT` in `walk-concurrency.test.ts` is
`DEFAULT_RETAINED_BYTES`.

**Done since.** The parse ended by encoding the finished tree again, which on a
copy cost 30 to 45 percent of its CPU in every shape tried; it no longer does
("Since: the re-encode taken out", above). The weights are of the parser as it
was, and are above what it needs now.

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

Three parts. The first two are bounds on a document; the third, since the
retention budget, is a bound on the resolve.

1. **Bytes in flight.** A request takes one of twelve slots, and a body may be
   as large as its request's bound: 64 MiB for an abbreviated packument, 96 MiB
   for a full one, and up to twice that for the instant the chunks are joined.
   By arithmetic from the bounds, not by measurement, twelve full packuments are
   1.1 GiB, and 2.3 GiB while joined. An artifact download has the same shape at
   128 MiB. What `MemoizingTransport` keeps of them is the retention budget's
   (below); a full packument asks for more than the memo's ceiling and is not
   kept.
2. **One parse.** Before the cost limit, 2,169 to 2,683 MiB (2.1 to 2.6 GiB) for
   an abbreviated packument and 3,149 to 3,956 MiB (3.1 to 3.9 GiB) for a full
   one, in the shapes tried. Now about the limit, 512 MiB and 720 MiB: the
   heaviest document each limit lets through, of the seventeen kinds tried, was
   read in a heap of 1 GiB with 558 MiB and 802 MiB at the largest peak (table
   in "A budget that weighs what a tree allocates"), and of eight kinds found
   since, objects of 86 members needed up to 1.23 times the limit and were read
   in a heap of 1 GiB with nothing to spare ("Shapes found since"); since the
   parse stopped encoding the tree again they need 1.06 times, with 99 MiB to
   spare ("Since: the re-encode taken out"), and with their member tables
   charged, about 0.54 of their cost ("The member table charged"). The parse is
   on the main thread, so it is one at a time.
3. **What a resolve keeps, and the budget on it.** Before, the provider kept
   every packument it had read, the body and the tree parsed from it, until the
   resolve ended, and nothing asked it to forget one: six different 12 MiB
   packuments held, after a collection, 188, 258, 328, 398, 468 and 538 MiB of
   heap (70 MiB for each, 5.8 times its size, in the dense shape then accepted
   whole). A real packument holds less for its size: after a collection the
   trees of the 22 surveyed kept 6.2 to 230 MiB for 2.2 to 76.5 MiB of text, 1.0
   to 3.2 times. Now a resolve keeps up to a budget, 256 MiB by default
   (`OPM_RETAINED_METADATA_MIB`, a whole number of MiB, `0` to keep nothing or
   `unlimited`; `RegistryOptions.maximumRetainedBytes`), counted by what is
   held:
   - Two things hold a packument. `MemoizingTransport` holds the response, at
     its length. `NpmRegistryProvider` holds the record: the objects parsed from
     the text, at what the parse measured the tree to keep
     (`PARSE_COSTS.retained`, within 5 to 60 percent above it for the real
     packuments), and the text, which the record keeps alive whether or not the
     memo does. Both report to one `RetentionLedger`
     (`@openpacker/adapter-core`), the memo's, which the provider finds on its
     transport (`HttpTransport.retention`).
   - The two are one entry. Each names the bytes it holds (`shares`: the
     response's body, which is the record's), and the provider's entry takes the
     memo's in: the text is counted once, a use of either is a use of both, and
     the two are let go together. Counted apart, the memo's entry was the older
     and went first, which freed nothing (the provider still had the bytes) and
     lost the memo's answer, so the provider's next use of a document it still
     held was a revalidation at the origin, and a registry that had published in
     between stopped the resolve with `STALE_METADATA` where the memo would have
     answered from memory. Now, while the provider holds a document, the memo
     holds it too and answers its revalidations, whatever the budget
     (`document-owner.test.ts`: a registry that publishes during a resolve gives
     the same lock at an unlimited budget, the default and a budget with room
     for the documents counted once and not twice, and over five budgets and
     sixty steps of concurrent reads no validator reaches the origin). A memo
     entry let go before the provider's tree was held, which takes two answers
     arriving in one turn, is taken back at no cost when it is (`reclaim`),
     unless the memo has fetched it again since.
   - When the total passes the budget the least recently used are released, a
     memo hit or a revalidation counting as a use, until it fits; an entry that
     alone does not fit is released too. So after any call the counted total is
     within the budget. What the resolve holds beyond it is what is in flight:
     the one document being parsed (the parse is synchronous, so there is never
     a second), the bodies of the requests in flight (twelve at most, each
     within its bound: "Bytes in flight" above), the trees the walk is using
     while it uses them, and the tree of a packument whose revalidation was out
     when the budget let it go, until the answer. A 304 counts that tree again,
     at the weight the record was counted at, and may let others go; a 200
     replaces it. (It used to only mark the entry used, which for an entry
     already released did nothing: the tree was held and never counted again.
     `retention.test.ts` holds a 304 back while the budget lets the packument
     go.) While the provider holds a document the memo answers its revalidation
     from memory, so the case needs two answers in one turn. "At most one
     document more than the budget", which this said before, is true of what is
     counted only: the peak the ledger records is at most the budget and the
     entry being added.
   - A released response is fetched again through the same transport. A released
     packument is read again, with no validator because there is nothing to
     revalidate; what stays of it is its etag, when it was retrieved and a
     digest of its text, taken as it was released, so the snapshot a provider
     gives (which names each document it read by that digest) is the same
     whatever was released. A document read again must be the document that was
     released: a resolve that took two versions of one packument would record
     evidence for neither, so a difference stops it with `STALE_METADATA`
     (`The registry changed the packument of x during the resolve; run it again`,
     whether the memo or the provider found the change), and `opm` exits 8, as
     for a registry it cannot use for now. The walk does not record it as a
     package it could not use: no package is to blame, and before, a resolve
     reported it as unsatisfiable (exit 5, or 9 from `opm resolve`).
   - Nothing is released that cannot be fetched again.
     `HttpTransport.refetchable` says a transport can be asked again for what it
     answered: `true` for `BoundedFetchTransport` when it fetches from the
     network itself, `false` for one built over a `fetch` it was handed
     (`RegistryOptions.fetch`), which may replay a sequence of answers, and
     absent (so no) for `FixtureHttpTransport`, which can serve a sequence of
     different answers, and for any transport written without it. A memo over a
     transport that is not refetchable has a ledger of unlimited budget, and a
     provider uses the ledger only of a refetchable one.
   - A packument that is not held is read once however many ask for it while it
     is being read. The walk asks for a package's packument from every candidate
     version at once, and each used to parse a tree of its own; with a budget
     that lets go, that would have read what was let go into memory several
     times over. It is also the larger part of the saving below.

   The resolve of `next`'s real abbreviated packument (the 25.6 MB document of
   the registry, served from a file) with sixty libraries of 1,000 versions
   added to its newest version, through the walk and the real provider and memo,
   the registry transport injected: 80 requests, 45.6 MB. Peak RSS
   (`ru_maxrss`), three runs each:

   | budget                       | requests | MB served | evictions | counted peak MiB | CPU s     | peak RSS MiB  |
   | ---------------------------- | -------- | --------- | --------- | ---------------- | --------- | ------------- |
   | the build before (no budget) | 80       | 45.6      |           |                  | 15.0-15.4 | 901, 882, 897 |
   | unlimited                    | 80       | 45.6      | 0         | 259              | 12.3-12.6 | 877, 877, 885 |
   | 256 MiB (the default)        | 80       | 45.6      | 1         | 256              | 12.5-12.8 | 884, 876, 892 |
   | 128 MiB                      | 81       | 70.1      | 11        | 129              | 12.4-12.7 | 747, 741, 746 |
   | 64 MiB                       | 132      | 85.6      | 220       | 129              | 9.8-10.3  | 585, 583, 588 |
   | none                         | 156      | 91.1      | 310       | 104              | 7.5-7.7   | 579, 579, 588 |

   These were measured before the memo's entry and the provider's for one
   document were made one, so the counted figures count each packument's text
   twice, once for each holder; peak RSS is what the process held either way.
   Measured again on the final build (one entry for a document, the parse not
   encoding the tree again), with the harness written again because the first
   was not kept: the same document as served on 2026-10-17 (25.66 MB), whose
   newest version (16.4.2) has its own dependencies replaced by the sixty
   libraries (`^1.0.0` each, each library 0.36 MB), resolved by `resolveGraph`
   from that version through the real provider and memo, the transport injected
   with etags and 304s. It asks for 61 documents, not 80 (the first harness's
   root and dependencies were not recorded), so the two tables are not
   comparable row for row. Three runs each, at a load of 8 to 19:

   | budget                | requests | MB served | evictions | counted peak MiB | CPU s   | peak RSS MiB  |
   | --------------------- | -------- | --------- | --------- | ---------------- | ------- | ------------- |
   | unlimited             | 61       | 42.6      | 0         | 180              | 2.8-3.0 | 316, 370, 373 |
   | 256 MiB (the default) | 61       | 42.6      | 0         | 180              | 2.9-3.4 | 370, 370, 371 |
   | 128 MiB               | 61       | 42.6      | 1         | 129              | 2.8-3.2 | 361, 362, 362 |
   | 64 MiB                | 72       | 71.1      | 40        | 104              | 3.9-4.4 | 459, 459, 460 |
   | none                  | 122      | 85.3      | 244       | 104              | 4.4-5.0 | 525, 527, 562 |

   The resolve now counts 180 MiB at its peak, each document's text once, so the
   default lets nothing go. A smaller budget costs memory here instead of saving
   it: with the parse no longer encoding the tree again, a tree is cheaper to
   keep than to parse again, and 64 MiB and none read `next` again (11 and 61
   more requests, 28.5 and 42.7 MB more) and peak at 459 and 525 to 562 MiB
   against 370. The counted peak passes the budget by at most the entry being
   added: 104 MiB for a budget of 64 and of none, `next`'s record alone. In the
   first measurement, the resolve counted 259 MiB at its peak, so the default
   evicts once and changes nothing measurable; 128 MiB takes the peak from 890
   to 745 MiB (16 percent) for one more request; 64 MiB to 585 (34 percent) and
   none to 582 (35 percent), and the CPU from 15 to 10 and 7.6 s, because less
   is alive to be collected, at the price of 52 and 76 more requests and 40 and
   46 MB more served. The counted peak never passes the budget by more than the
   one document being added (`next`'s record counts 105 MiB): 129 MiB for a
   budget of 64, where 64 + 105 would be 169. The peak does not fall below 580
   MiB, which is the parse of `next`'s one large packument and the walk's own
   work. Load was 4 to 31 over the three rounds; peak RSS did not move with it,
   CPU and wall did. Against the live registry, `opm resolve pkg:npm/next` (22
   packages), three runs of the build before and the build after at the default
   budget: 939, 888 and 800 MiB and 19.1 to 20.6 s before; 485, 575 and 441 MiB
   and 11.3 to 13.8 s after. That is not the budget: the same build with the
   single read of a packument taken out of `NpmRegistryProvider` (an edit of the
   built file, the only change) gave 892 and 809 MiB and 21.2 and 21.6 s. It is
   the walk's concurrent asks for `next` reading it once and not once for each.
   The fixture above does not ask for `next` that way, which is why it shows
   nothing for the default.

   The lock is the same. `retention-differential.test.ts` resolves four
   registries shaped like the repository's resolver fixtures (a diamond, a
   platform package with an optional dependency per platform, dev-time
   specifiers the walk must not follow, a heavy packument beside light ones) and
   three graphs of 36 to 60 packages drawn from a seed, with a budget of
   nothing, of 1 MiB and none stated, and asserts the same lock, snapshot
   digests included, with the registry asked again more often when it kept less.
   `opm-project`'s whole suite was also run with `OPM_RETAINED_METADATA_MIB=0`
   and `=1` (775 tests, one skipped): every test that does not count fetches
   passes at both; at `0` the two that count them, "locks the closure of a
   package the size of typescript, reading it once" and "fetches each packument
   once across the direct pass, the walk and the artifacts", fail by design, and
   at `1` the first of them.

Before this change, measured on the final build of the earlier amendment, Node
22.22.0, linux/x64, live registry, in a project written by `opm init` with its
default policy:

|                                             | requests | wire bytes | wall   | peak RSS |
| ------------------------------------------- | -------- | ---------- | ------ | -------- |
| `opm add pkg:npm/typescript@5.9.3`          | 3        | 8,041,336  | 4.6 s  | 365 MiB  |
| `opm sync` (`native_projection = "layout"`) | 3        | 8,043,278  | 4.8 s  | 362 MiB  |
| `opm add pkg:npm/@types/node`               | 4        | 1,632,949  | 2.4 s  | 160 MiB  |
| `opm add pkg:npm/vitest@4.1.9`              | 160      | 17,342,455 | 16.3 s | 440 MiB  |
| `opm resolve pkg:npm/next`                  | 108      | 14,570,411 | 20.9 s | 838 MiB  |
| the same with `--max-old-space-size=256`    | 108      | 14,569,442 | 23.1 s | 463 MiB  |

Wall and peak RSS are one run each on the final build, made again for the last
review of this amendment (peak RSS is `ru_maxrss`, in KiB, divided by 1,024; the
load average was 2.2 at the end of the runs). The first run gave 4.7, 4.7, 2.5,
13.8, 22.5 and 34.2 s and 367, 362, 167, 433, 958 and 458 with the unit not
kept. Five of those six are within 5 percent of the MiB figures here (four
within 2 percent) and `next` is not (958 against 838), so they are read as MiB.
Requests and wire bytes are the first run's, counted with a diagnostics-channel
preload that was not run again. Wire bytes are as received, compressed, tarballs
included. The three requests for `typescript` are its abbreviated packument, its
full packument (for the publish time of a package modified within the last day)
and the tarball. `vitest` is the 160 requests, none repeated, of the table
above. The resolve of `next` holds a 25.6 MB packument and finishes inside a 256
MiB old-space limit, so the 838 MiB at the default limit (958 in the first run)
is the collector's slack and not live data.

The largest documents found, on the final build. The first two rows are the wall
time and peak RSS of the `opm` process; the last two call `publishTime` of the
real provider in a script, which reads the abbreviated packument first and then
the full one (peak RSS in MiB: `ru_maxrss` in KiB, or `maxRSS`, divided by
1,024):

| command                                                             | wall   | peak RSS  |
| ------------------------------------------------------------------- | ------ | --------- |
| `opm resolve pkg:npm/%40prisma/client` (36.41 MiB abbreviated)      | 9.0 s  | 525 MiB   |
| `opm resolve pkg:npm/public-unscoped-test-package` (36.56 MiB)      | 7.1 s  | 487 MiB   |
| full packument of `@wix/wix-code-types` (72.96 MiB, then 25.94 MiB) | 9.5 s  | 1,031 MiB |
| full packument of `@prisma/client` (65.35 MiB, then 36.41 MiB)      | 13.6 s | 819 MiB   |

Both resolves exit 0. `opm add pkg:npm/%40prisma/client` reads the same
packument and then stops at its tarball with
`Unsafe archive rejected (EXPANDED_SIZE_LIMIT): 67108864`, which is the
archive's bound on what it expands to and is not touched here.

### Limits

- The other ecosystems' metadata bounds (cargo, PyPI, NuGet, Go, Maven: 8 MiB
  each) were not measured against their registries here. They keep the 200,000
  value limit and the default cost limit of 256 MiB
  (`DEFAULT_METADATA_PARSE_COST`). The value limit alone was not a cost limit:
  200,000 empty objects keep about 40 MiB, but 200,000 values can be 66,600
  objects of two members named by array indices, 1.3 MB, which V8 gives about 40
  KiB each ("A member named by an array index").
- The cost limit allows a tree that costs at most 512 MiB (abbreviated) or 720
  MiB (full) by `PARSE_COSTS.peak`. The heaviest document it lets through, of
  the seventeen kinds of the tables above sized at 0.95 of the limit or at the
  byte bound, was read inside a heap of 1 GiB (`--max-old-space-size=1024`) in
  at most 8.7 s of CPU (abbreviated) and 12.8 s (full), with a peak heap of 558
  and 802 MiB and a peak RSS of 807 and 1,021 MiB; the two heaviest of the full
  limit were also read inside 900 MiB. Of the eight kinds found since, each in
  ASCII and with one `€`, at 0.97 of the limit, every one was read inside 1 GiB
  too, in at most 8.9 s (abbreviated) and 14.6 s (full) and at a peak RSS of at
  most 981 and 1,362 MiB, but the heaviest of them, objects of 86 members with a
  `€` at the full limit, had nothing to spare: its least heap in a bisection was
  1,022 to 1,043 MiB, and it completed in every run at 1,024 ("Shapes found
  since"). Since the parse stopped encoding the tree again, its least heap is
  925 MiB ("Since: the re-encode taken out"), and with the member tables charged
  the heaviest document of that shape the limit lets through needs 496 MiB ("The
  member table charged"). The load was 4 to 17, so wall seconds ran to 10.4 and
  18.7 and were 12.6 at a load of 4. These are the heaviest kinds tried and not
  a proven maximum: a kind that allocates more for each unit of cost than any of
  them would exceed the figures (objects of members named by array indices were
  such a kind, 65 times over: "A member named by an array index"), which is why
  `parse-calibration.test.ts` measures twelve again on whatever Node runs the
  tests. The heap leaves room for the text of the document, which is two bytes a
  character if one is past U+00FF (128 MiB and 192 MiB), and for 43 MiB of the
  process: 683 MiB and 955 MiB.
- Before the cost limit the value limit allowed 2,169 to 2,683 MiB in 22.5 to
  30.4 s for an abbreviated packument and 3,149 to 3,956 MiB in 37.1 to 44.1 s
  for a full one (history, the tables above); 64 MiB of one object of
  12-character names with an empty object each was accepted and ended a process
  under `--max-old-space-size=1024` and `=1536` with exit 134.
- A document the bounds let through can still be fatal under a heap smaller than
  1 GiB: the figures above are for 1 GiB and 900 MiB, and the weights were not
  tried against 512 MiB, where documents of 500 to 800 MiB of peak would not
  fit. A refusal is not fatal at any heap that holds the document's text and the
  cost limit's worth of tree.
- The 1 GiB is a bound on one document. A resolve holds, besides the document it
  is parsing and that document's text, what its budget counts (256 MiB by
  default, by an estimate that for the objects of a few dozen members above is
  up to 1.64 times under what they keep), what it is using, and the bodies in
  flight, so its peak is about the budget plus the largest parse, which against
  a hostile registry is more than 1 GiB. Measured through the real memo and
  provider at the default budget, `publishTime` of a hostile abbreviated
  packument and then a hostile full one, each at 0.97 of its limit (objects of
  86 members with a `€`, before the parse stopped encoding the tree again),
  under `--max-old-space-size=1024`: the call held the abbreviated tree in its
  own frame while it waited for the full one, and the process ended with exit
  134 in both runs, where the full document alone completes. It now reads the
  abbreviated document in a frame that has ended by then (`publish-time.ts`;
  `held-packument.test.ts` measures the heap while the full one is on its way:
  112 MiB of the abbreviated tree before, 0 after), and the pair completes, at a
  peak RSS of 1,521 and 1,522 MiB and 18.8 and 20.6 s of CPU (a load of 15 to
  20). The review measured 1,427 to 1,445 MiB and 13.5 to 17.2 s for its pair.
  That is accepted for opm as it is run, and not claimed as a bound under a 1
  GiB heap: opm runs with Node's default heap (on the 16 GB machine of these
  measurements Node 22's limit is 8,240 MiB), the pair does not end it there,
  and no one document of the kinds tried ended a process under 1 GiB (88
  documents, 44 kinds at each limit, "A member named by an array index"). That
  is a measurement of those kinds and not a proof that none can: until the
  charge for a member named by an array index, one could, at both limits. A
  resolve held to 1 GiB would need a budget, and a full packument limit, that
  leave room for each other, which is a decision about the real packuments
  first.
- A refusal for cost or for values is exit 9 (`internal`) from `opm`, as a
  registry's other unusable document is (`INVALID_PROVIDER_METADATA`), where a
  refusal for bytes is exit 8. That is how it was; it is not changed here.
- A resolve keeps what it reads up to a budget of 256 MiB (above), counted at
  the parse's estimate of the tree plus the text, which is above what the tree
  keeps for every real packument (1.05 to 1.6 times) and below it for none of
  the 38 shapes it was fitted on by more than 1 percent. For shapes found since
  it is below what the tree keeps by up to 1.64 times (objects of 86 members,
  above) and 1.3 times (600,000 small integers in an array, which V8 has grown
  by half again: 11.7 bytes an element against 9), so a budget filled with such
  trees holds up to 1.64 times what it counts. For an object whose members are
  named by array indices it is above what the tree keeps in every one of the 26
  kinds measured, by 1.30 times at least (two members, 1,023 and 2,575) and by
  120 times for an object of one member, since the first index-named member is
  charged for the store V8 may give it ("A member named by an array index"); a
  budget filled with such trees therefore holds less than it counts, and a
  resolve evicts earlier than it need. The estimate is a model and not a
  measurement of the process: what the walk is using is not in it, and neither
  is what a provider other than npm's keeps (the cargo, Go, Maven, NuGet and
  PyPI providers keep their records, and their bodies with them, without
  reporting them, so the memo's budget does not free those bodies for those
  ecosystems; their documents are 8 MiB at most). The budget needs a transport
  that can be asked again (`refetchable`); a transport written without the flag
  is kept whole.
- The budget changes what a resolve costs, not what it finds, for the registries
  the tests drive (7 scenarios, three budgets) and for the whole suite of
  `opm-project` at `0` and at `1` MiB. A registry whose document changes during
  the resolve now stops a resolve that let go of that document, with
  `STALE_METADATA` and exit 8, where a resolve that kept it would not have
  noticed; at the default budget that is a resolve of more than 256 MiB of
  packuments, and never a document the provider still holds.
- What the tests hold: the stop at the limit for `{},` and `1,` at exactly 64
  MiB and for the object of members that used to be accepted
  (`packument-hostile.test.ts`, which asserts where the parser stopped and not
  how long it took); the same document in a child process under a 1 GiB heap, a
  refusal and not exit 134, and the heaviest accepted document read
  (`hostile-packument.test.ts`); the weights, the stop at a cost, and the
  heavier encoding refused earlier (`parse-costs.test.ts`); the estimate against
  the heap on this Node (`parse-calibration.test.ts`); the real packuments'
  headroom and the repository's packuments (`packument-headroom.test.ts`); the
  ledger, the memo's eviction and refetch, the provider's tombstones, the digest
  check and the single read, and the same lock at three budgets; one owner for a
  document's bytes (`retention-shares.test.ts`, `document-owner.test.ts`: the
  same lock under a registry that publishes during the resolve, at an unlimited
  budget, the default and a pressed one, and no validator reaching the origin
  over five budgets of concurrent reads), a packument counted again when a 304
  brings it back after it was let go (`retention.test.ts`), the abbreviated tree
  not held while the full one is read (`held-packument.test.ts`), the exit codes
  through the CLI, 8 for a registry that changed a document and 2 for a budget
  written wrongly, the latter from the real binary (`retention-exit.test.ts`), a
  transport over an injected `fetch` that does not say it can be asked again
  (`refetchable.test.ts`), the heap-number charge (`parse-costs.test.ts`), a
  parse that does not encode the tree again and still refuses what that encoding
  refused (`parse-once.test.ts`), the member-table model against what an object
  of 0 to 128 members kept and the charge for it, the estimate at or above what
  an object kept at every count (`member-tables.test.ts` over
  `member-tables.json`), and the member counts of every surveyed packument's
  objects, which must add up to its row and are charged in its cost, at most 85
  percent of its limit (`packument-headroom.test.ts` over
  `packument-survey-objects.json`), the charge for a member named by an array
  index against what 26 kinds of object kept, the exact charge, an escaped name
  and the names that are not indices (`elements.test.ts` over `elements.json`),
  the cost limit every registry document is read under, the 66,600-object
  document refused and the 66,000-object one read whole
  (`metadata-json.test.ts`), objects of index-named members at both byte bounds
  in a child under a 1 GiB heap, a refusal and not exit 134
  (`index-names.test.ts`), and a user name and a password before a host with no
  scheme, withheld beside one with a scheme (`redact-text.userinfo.test.ts`,
  `lock-tree.userinfo.test.ts`). The weights' other shapes, the 96 MiB bodies,
  the time figures, the live-registry runs, the peak RSS of the resolve of
  `next`, and, for the member named by an array index, the 38 shapes again, the
  hostile set and the least heaps at 0.97 of each limit, and the live counts of
  index-named members were measured by scripts run for this amendment, which are
  not in the repository, and no test fails if those figures change.
- The full packument of `@wix/wix-code-types` is at three quarters of its byte
  bound (72.96 of 96 MiB) and costs 598.0 of 720 MiB by its composition as read
  again on 2026-10-17 with its member tables charged, and 598.3 by the parser
  (561.6 and 561.9 before the charge): the limit is 1.20 times what it needs,
  and it needs 83.1 percent of the limit, leaving 16.9 percent, where its parse
  needs 196 MiB at the peak. The headroom test holds every real packument to at
  most 85 percent of its limit, which was four fifths before the charge ("The
  member table charged"). So it would pass 85 percent at 74.7 MiB and its cost
  would bind at 87.8 MiB if it grew in the same shape, though it grows only 0.35
  MiB a year. **Known limit.** It has 13.7 MiB of margin to the 85 percent rule
  and its cost grows about 2.8 MiB a year (70 versions published in the last 365
  days, about 0.04 MiB of cost each; 15,119 versions in all), so the rule has
  about five years for it, and the limit itself (121.7 MiB under) about forty.
  The headroom test reads the recorded survey, not the registry, so the growth
  will not turn it red by itself: the survey is to be read again before then. To
  raise the limit safely: read the survey again and add the new heaviest
  document; keep the limit, the two-byte text of the byte bound and 43 MiB of
  process under the heap the hostile tests use (`--max-old-space-size=1024`),
  with the 7 percent left now, or raise that heap together with the limit; run
  the hostile set and the 38 shapes again on the new limit; and, if the weights
  are to change, fit them again against measured peaks. `renovate`'s full
  document is at 72 percent of its byte bound (69.14 MiB on 2026-10-17, 68.58
  five days before) and costs 540.4 MiB with its member tables charged; it
  reaches 96 MiB in about 1.3 years at last year's pace, before its cost reaches
  the limit (at 1.33 times under), and its abbreviated document reaches 64 MiB
  in about 2.9, costing 487 MiB of 512 by then with its member tables charged;
  the bounds should be revisited before then. Raising the full packument's byte
  bound means accepting a larger limit: the heap left for a document of 96 MiB
  of two-byte text is already 7 percent.
- The sample is 4,887 names and the full packument of 400 of them (above); it is
  not the registry, and it missed `renovate`, which a second look found. The
  composition of each of the 22 packuments in `packument-survey.ts` is of one
  day.
- Parsing is the cost of a large document: the canonical parser read 14 to 17 MB
  a second, `next`'s packument took 1.4 s of CPU, `renovate`'s abbreviated 2.0
  s, `@wix/wix-code-types`'s full 4.2 s, and the resolve of `next` was CPU-bound
  at 11 to 14 s. The parse then ended by encoding the finished tree again; it no
  longer does ("Since: the re-encode taken out"), and on 2026-10-17, two runs
  each, `next`'s packument took 0.80 to 0.88 s against 1.40 to 1.49 s with the
  encoding, `@wix/wix-code-types`' full 2.1 to 2.3 s against 4.0, and
  `renovate`'s full 2.0 s against 3.9 to 4.1: 29 to 36 MB a second.
- `opm add` of `@prisma/client` and `@wix/wix-code-types` stops at their
  tarballs on the archive's expanded-size bound (64 MiB), a different limit that
  is not changed here.
