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
  document `opm manifest` prints on stdout (3), both in the known limits below.
  Outputs for text with nothing hostile in it (`x` in each field, 2,975 outputs
  of 13 commands, timestamps masked) are identical on both trees.
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
  `lock-import` and `receipts` repeat a native lock's or a receipt's text and
  are depended on by `openpackerd` and `openpacker-cli`, not by `opm`; no
  package depends on `closure` or `ocm`. **Not covered at all:**
  `apps/openpacker-cli` (its `openpacker: ${message}` has no writer and no
  scanner, and its message can repeat what a PREX client or the daemon says),
  `apps/openpackerd`, and anything outside the `opm` command line.
- **Known limits of what is claimed above.**
  - There is no gate on stdout. `stderr-writers.test.ts` holds stderr, and the
    writer keeps line feeds, so a new line on stdout, or a new error that
    repeats a value from a cloned repository, forges a line until someone wraps
    it in `plainLine` or `echoed`. The four findings above were this.
  - A script's own output passes through raw by design, and so do the shell's
    own lines that echo the script's text (`sh: 1: ...: not found`) and a
    child's stderr.
  - `opm manifest` writes a JSON document on stdout. JSON escapes the escape
    character and the line feed, and a bidirectional or C1 character inside one
    of its strings is the document's content; its stderr is held to the rule.
  - `lock-import` repeats a key of `pnpm-lock.yaml` raw. Only `openpacker-cli`
    and `openpackerd` reach it, so it is outside this amendment.
  - A document of the wrong JSON type can still reach an uncoded `TypeError`:
    `"schemaVersion": {}` in `opm.lock.json` gives `opm: internal error: ...`,
    as it does on `a3891a9` and did on `8713e6d`. That is a message with no
    code, not a forged line.
  - The values `opm search`, `versions`, `info` and `resolve` print come from a
    registry. They are written as the registry adapters returned them, and
    stdout does not flatten them again; the fuzz was offline and did not reach
    them.
  - What the fuzz did not reach: online resolution and the closure message,
    `opm pack` of a real project beyond the environment-file case (the fuzz ran
    `--dry-run`), `opmx`, `publish` and `yank`, `auth.json`, an installed
    plugin's own output, and the Maven, Go, OCI and host-manager adapters
    through the binary (unit tests only). The report lines of a native
    projection, of `opm resolve` and of a host install, and the names `opm exec`
    finds in `node_modules/.bin`, are made plain at the line but no test drives
    them with hostile text.
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
  caught, the 26th is the allowed form) and four more. It scans `apps/opm/src`
  only: `apps/openpacker-cli` and every other package are outside it. Eleven
  writers were not routed before this; the plugin-store one is also driven for
  real (a hostile `OPM_PLUGIN_HOME`), and the rest are held by the list, because
  they need a registry or a module mock, which the repository's lint rejects.
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
