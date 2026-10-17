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
   version either, so `isExactVersion` takes any hint after `@` for a version,
   and a range or a tag is sent to the plugin as written, for its registry to
   accept or refuse. The policy, digest and size refusals propagated before and
   still do.

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
- A packument over 8 MiB is refused by the adapter's bound.
- The `os`/`cpu`/`libc` predicate is evaluated for npm only.

## Amendment (2026-10-17)

§1's list of specifiers that are never read as the registry's package of that
name, and the limit "A runtime dependency written as git, URL, alias or dist-tag
is refused", now hold for git, URL and file specifiers only. An `npm:` alias is
followed since ADR 0054, and a plain dist-tag since ADR 0054's amendment of
2026-10-17: both name the registry package exactly as a range on the same key
does.
