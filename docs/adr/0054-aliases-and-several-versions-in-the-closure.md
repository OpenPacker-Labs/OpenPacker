# ADR 0054: Aliases and several versions of one package in the closure

- Status: Accepted
- Date: 2026-10-12
- Amends [ADR 0044](0044-a-closure-is-what-the-host-installs.md) §1 (an `npm:`
  alias was refused) and §4 ("a lock holds one version of a package")
- Relates:
  [0043](0043-one-copy-per-machine-and-a-node_modules-node-can-resolve.md) (the
  layout nests; it now also places by install name),
  [0046](0046-a-lockfile-is-installed-not-re-resolved.md) (a frozen install
  already installs both shapes, because an npm lock records a path per package),
  [0049](0049-workspaces-are-a-model-before-they-are-an-install.md)

## Context

Two defects were found live, and they are one gap: an `opm.lock.json` names a
package by one key, and a key is a package name.

1. **`npm:` aliases.** `opm add npm@10.9.4` failed `UNSATISFIABLE`. npm lists
   its 68 dependencies as `dependencies`, the closure walk went through them,
   and `@isaacs/cliui@8.0.2` says
   `"string-width-cjs": "npm:string-width@^4.2.0"` (also `strip-ansi-cjs` and
   `wrap-ansi-cjs`). The adapter threw on the specifier, so that version could
   not be inspected, left the candidate set, and everything above it became
   unsatisfiable. The same edge is in the lockfiles of the repositories opm has
   to install: counted from their `package-lock.json`, ts-autocode has 6
   distinct alias edges (10 placed entries whose directory is not their name),
   gitlang 9 (17 placed entries: `string-width-cjs`, `strip-ansi-cjs`,
   `wrap-ansi-cjs`, the `@openai/codex` platform builds written as
   `"@openai/codex-linux-x64": "npm:@openai/codex@…-linux-x64"` in
   `optionalDependencies`, the jco componentize build); HoBo's `pnpm-lock.yaml`
   has 10 by the assessment of 2026-10-12.
2. **One version per name.** `opm add tinybench` next to `vitest@4.1.9` (which
   needs `tinybench@^2.9.0`) pinned `tinybench@6.2.2` directly and failed with
   who requires what, because ADR 0044 §4 withdrew every candidate of a package
   but one and solved again. npm and pnpm nest. Names that a real lock holds in
   more than one version: 15 of 416 in ts-autocode, 29 of 751 in gitlang, 101 of
   870 in ceremony (their `package-lock.json`), 248 of 1,791 in HoBo. `opm ci`
   already installs such locks, and the layout planner already nests; only the
   resolver and the lock model refused.

What an alias is, in npm's terms (`npm-package-arg`, which is what the oracle
uses): `name@npm:target[@spec]` where the dependency key is the directory the
package is installed in, `target` is the registry package whose `package.json`
`name` it keeps, and `spec` is a version, a range, a dist-tag, or nothing, which
is `*`. An alias of an alias, and an alias of a git, URL or file specifier, are
errors in npm.

## Decision

### The specifier

1. **An alias is read, and is followed where a plain range is.** In
   `dependencies`, in `optionalDependencies` (where it runs) and in required
   `peerDependencies`. `npm:name@^4.2.0`, `npm:@scope/name@^4`, `npm:name` (any
   version, which is `*`: prereleases excluded, as npm's), `npm:name@1.2.3` and
   `npm:name@next` (a dist-tag) are all read. A `devDependencies` alias stays
   what ADR 0044 §1 made it: kept as an unconstrained requirement with an `info`
   loss, never walked. A nested alias, an alias of a git, URL, file or workspace
   specifier, an alias with no name, and an unparsable alias fail by name where
   the walk follows the field; the walk never reads them as the registry's
   package of the install name, which is the dependency-confusion case ADR 0044
   closed (a registry package called `string-width-cjs` exists). A plain
   dist-tag (`"foo": "latest"`) is still refused: only an alias names a package
   explicitly enough to resolve a tag for it.
2. **The requirement names the real package and carries the install name.**
   `expression.purl` is the target (`pkg:npm/string-width`), `vers` is the
   comparison form of its range, and `nativeSemantics.data` gains `installName`
   (`string-width-cjs`) and `aliasSpec` (the specifier verbatim). `range` is the
   target range, so every consumer that reads a range reads the right one; a tag
   is `specKind: "tag"` with `range` the tag. The requirement `id` already used
   the dependency key, which is unique per depender.
3. **A dist-tag is resolved by the registry's `dist-tags`** through an optional
   `resolveTag` on the catalog provider (npm implements it from the abbreviated
   packument the walk already holds, so no request is added), once per walk
   step, to an exact version that then travels as an exact range. The lock
   records the version, not the tag, because a tag moves.

### The solve

Approaches compared.

| Approach                                                                                            | What it asks of the engine                                   | Why not / why                                                                                                                                                                                                                    |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. One variable per (package, requirer scope), as npm's placement does                              | A universe node per (version, scope); a scope per dependent  | The universe grows with the number of dependents, not versions, and a requirement's meaning would depend on where its dependent lands, which the solve is what decides. The checker could not re-validate it as a plain closure. |
| B. Nested solving: solve a subtree under each conflicting dependent                                 | One solve per conflict, each with its own universe and proof | Several proofs to digest and bind to one lock, and conflicts inside a nested solve recurse. The cost is paid in the common case (a diamond) for the benefit of the rare one.                                                     |
| C. One solve over all candidates with coexistence, edges assigned after it, split only where forced | The request it already gets (`allow_multiple` is on)         | **Chosen.** One proof, one universe, nothing new for the engine or the checker; the edge assignment is a deterministic function of the selection and is checked by the ecosystem's own range rules, as ADR 0044 §3.              |
| D. Keep forcing one version (status quo)                                                            | n/a                                                          | A closure npm installs is refused.                                                                                                                                                                                               |

4. **The request is unchanged** (`satisfy-hard-constraints`,
   `exclude-lifecycle-denied`). The engine's oracle objective still is not asked
   for; nothing here needs an optimum, and the lock claims no more than that
   every requirement is satisfied and that the checker re-validated that.
5. **Selection, then assignment, then pruning.** After a solve:
   - each installed requirement of each selected package is assigned the
     **newest selected version the ecosystem's own range accepts** (so a package
     that two dependents can share is shared, and a dependent is never left on
     an older release than another that suits it);
   - what no assigned edge and no direct requirement reaches is dropped (the
     engine may select a version for an edge that a newer selected version also
     suits);
   - a name still selected at several versions is **unified when one release
     satisfies every edge to it** (ADR 0044 §4's rule, kept: the lock is smaller
     and the tree flatter, and a closure that locked before locks the same);
   - it is **kept at several versions only when no single release suits every
     dependent**, and only when no required peer dependency points at it. A peer
     must resolve to the instance its dependent's parent sees, so a name any
     package requires as a peer keeps the old refusal and its who-requires-what
     message. (npm says `ERESOLVE` there.)
6. **Deterministic.** The universe is built in the walk's queue order, the
   engine is deterministic for one universe, assignment and pruning iterate in
   solve order, and keys are allocated from sorted input. Two resolves of one
   registry state write one lock, byte for byte.
7. **Policy is applied to the real package.** The release-age gate, the
   source-kind gate, trust and every other fact are evaluated on the exact PURL
   of the target (`pkg:npm/string-width@4.2.3`), before the alias is considered.
   An alias cannot be a way to a package the policy refuses, and a denial names
   both the edge (`string-width-cjs` as `npm:string-width@^4.2.0`) and the
   package.

### The lock

8. **Keys.** An entry is still keyed by an `alias` that is a safe path segment
   (ADR 0043's rule). A direct entry keeps its manifest alias. A transitive
   entry keeps the key it has always had, the package name with `/` and other
   characters outside `[A-Za-z0-9._-]` as `-`, **when its name is selected
   once**. A name selected at several versions has no plain key: each transitive
   version is `<name>.<version>` (the same character rule), a direct one keeps
   its alias, and a collision with any other key takes a numeric suffix, in
   sorted order. An existing lock, which has no alias and one version per name,
   reads and re-writes byte for byte, and a resolve of the same closure writes
   the same keys.
9. **Edges.** A plain edge stays in `dependencies`: the keys of the entries an
   entry requires under their own names, sorted. A requirement installed under
   another name than its target's package name is not there; it is
   `aliases: { "<install name>": "<key>" }` on the entry that has it (sorted by
   install name, written after `dependencies`, absent when empty). An entry's
   edges are the union of the two, and every reader asks `lockEdges` /
   `lockEdgeKeys` (`lock-edges.ts`), so reachability for `remove`, `sync`, the
   layout and `why` sees both. A lock with no alias has no `aliases` and reads
   as it always did. A direct requirement installed under an alias has
   `installName` on its entry. An entry's own `purl` and `version` are the
   target's: the bytes, the bins and the policy are the real package's.
10. **A direct alias, and a direct range or tag.**
    `opm add string-width-cjs@npm:string-width@^4.2.0 -e npm` writes
    `[packages.string-width-cjs]` with `purl = "pkg:npm/string-width"`,
    `version = "^4.2.0"` and `install_name = "string-width-cjs"`, and
    `package.json` gets `"string-width-cjs": "npm:string-width@^4.2.0"`.
    `--alias` keeps meaning the local label it always was. A direct version that
    is a range or a dist-tag (`^4.2.0`, `next`) is resolved against the registry
    to the newest release inside the minimum release age, by the ecosystem's own
    range rules (`registry-target.ts`); the lock records the exact version. A
    bare `*` excludes prereleases, as npm's.

### The layout and everything that reads one version per name

11. **The planner places by install name.** A dependency is
    `{ install name, entry }`; the install name defaults to the entry's package
    name, so a lock without aliases plans what it planned. A directory in
    `node_modules` is the install name, and so is the segment of the `.bin`
    shim's relative path. A package's bare `bin` string is named by its own
    `package.json` `name`, not by the directory (ADR 0046 §6, which the frozen
    path already did). Two install names of one version are two directories, as
    in npm. An install name that shadows another package's name (`react` for
    `preact`) is judged by what it resolves to, so the same name for two entries
    nests.
12. **`opm list`, `opm why`, `opm remove`, `opm update`/`sync`, gc.**
    - `remove` reaches through `dependencies` and `aliases` both; `sync` and
      `update` re-resolve through the same walk, so an aliased direct
      requirement keeps its install name across a range change.
    - `list` shows the key, the PURL, and `as=` the install names that differ
      from the package name.
    - `why <name>` accepts a manifest alias, a lock key, a package name or an
      install name, and prints each match with the entries that require it and
      the install name they use.
    - `.opm/bin` shims are per name, so two versions of one bin keep the direct
      requirement's, and a shim is removed only by the entry it points into.
    - generations and `gc` are keyed by store path and are unchanged.
    - `lock-import` reads `package-lock.json` into PREX and was already keyed by
      exact PURL; it is unchanged.

### Bundled dependencies

13. **A dependency a package bundles is not walked.** `bundleDependencies` lists
    names that ship inside the package's own tarball (`npm` bundles all 68). npm
    does not resolve them (`@npmcli/arborist` `buildIdealTree` of `npm@10.9.4`
    is one node) and `opm ci` already leaves an `inBundle` entry to its parent's
    archive (ADR 0046 §3). The walk now does the same: the edge is recorded as
    bundled and not followed. The bytes are covered by the parent's digest and
    policy decision, as in the frozen path. Without this, `opm add npm@10.9.4`
    would install 68 packages and their closure beside it that npm would never
    fetch.

### Two things the live runs exposed

14. **The engine is told only what can be installed, and its checker names a
    witness the way the solve does.** A release with a hard requirement that no
    candidate can meet is taken out before the solve, to a fixed point
    (`viableCandidates`): Resolvo answered UNSAT for a release that depends on
    another release of its own name next to one that cannot be installed, though
    a closure existed, which a property test found. The engine's proof checker
    picked a requirement's witness among the selected nodes in node-id string
    order while the solve picks by universe index, so two selected releases that
    one requirement accepts failed with
    `proof check failed: requirement witness nodes incomplete`
    (`crates/openpacker-resolver/src/checker.rs`; a Rust test fails before the
    change). An unsatisfiable closure is reported as the dependents, the install
    names and the ranges, never as the engine's JSON.
15. **A scoped package is one package however the manifest spells it, and an
    archive is bounded as `opm ci` bounds it.** `pkg:npm/@isaacs/cliui` (what a
    person types) and `pkg:npm/%40isaacs/cliui` (what the lock holds) are
    compared in their canonical form. Before, `opm install` after `opm add` of
    any scoped package was refused as a lock that does not match its manifest,
    and the layout took the project's own scoped dependency for a transitive
    one. `opm add` and `opm install` extract under the bounds `opm ci` does
    (`install-limits.ts`: 256 MiB packed, 1 GiB unpacked, a hundred thousand
    files) and read an npm archive the way npm reads it, because the platform
    build codex aliases is 92 MB packed and agent-base@7.1.4, which npm's own
    closure reaches, is published with `package/./dist/index.js`.

## Consequences

All numbers are from this host (linux x64, Node 22.22.0) against the live
registry on 2026-10-12, with the default minimum release age of 1,440 minutes,
counted by a diagnostics-channel subscriber on undici's request events (requests
are every HTTP request opm made; bytes are response bytes on the wire). "Before"
is the build this change started from (`openpacker-lockci`, `b1e7ba4`).

**What now works**

| Command                                                                                    | Before                                                                                                                                     | After                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `opm add pkg:npm/npm@10.9.4`                                                               | exit 5, `UNSATISFIABLE`, after 185 requests / 5.80 MB / 20.7 s                                                                             | one package: 2 requests / 2.98 MB / 27.4 s (26.5 s from a warm store: extracting and linking its 2,277-file archive)                                                                                    |
| the same, as arborist sees it                                                              | n/a                                                                                                                                        | `buildIdealTree` of `npm@10.9.4` is one node, `node_modules/npm 10.9.4`; opm's lock holds `npm` and its layout `["npm"]`: **equal** (npm bundles its 68 dependencies, §13)                              |
| `opm add pkg:npm/vitest@4.1.9`                                                             | 160 requests / 17.34 MB / 16.4 s / 44 packages                                                                                             | 160 requests / 17.34 MB / 16.1 s / 44 packages; the lock entries are identical to the old build's                                                                                                       |
| then `opm add tinybench`                                                                   | refused: `pkg:npm/tinybench is needed at versions no single release satisfies, and a lock holds one version of a package: …`               | 161 requests / 17.37 MB / 15.8 s; 45 packages; `node_modules/tinybench` 6.2.2, `node_modules/vitest/node_modules/tinybench` 2.9.0; `vitest --version` runs                                              |
| `opm add pkg:npm/@isaacs/cliui@8.0.2`                                                      | exit 9 after 1 request: `depends on string-width-cjs as "npm:string-width@^4.2.0", a alias specifier that is not a registry version range` | 29 requests / 172 KB / 2.7 s; 17 lock entries, 23 placed copies; `string-width-cjs` (4.2.3), `strip-ansi-cjs`, `wrap-ansi-cjs` and `@isaacs/cliui` run                                                  |
| `opm add pkg:npm/@openai/codex@0.136.0`                                                    | installs the 4 KB wrapper and none of its six platform builds (the alias is skipped); `bin/codex.js` throws when it starts                 | 5 requests / 93.0 MB; two packages, `node_modules/@openai/codex-linux-x64` is `@openai/codex@0.136.0-linux-x64`, the five other platforms are not fetched; `codex --version` prints `codex-cli 0.136.0` |
| `opm add pkg:npm/@bytecodealliance/jco@1.24.3`                                             | exit 9 after 1 request: the same refusal, for `componentize-js-0-19-3`                                                                     | 515 requests / 107 MB / 66.7 s; 125 lock entries; `componentize-js` 0.21.0 and, as `componentize-js-0-19-3`, 0.19.3; `jco --version` prints 1.24.3                                                      |
| `opm add glob@10.4.5 -e npm`                                                               | exit 5, `UNSATISFIABLE`, after 20 requests; the reason is the same refusal, two lines down                                                 | 65 requests / 1.2 MB / 7.8 s; 35 lock entries; `require('glob')` and `require('string-width-cjs')` run                                                                                                  |
| `opm add 'sw@npm:string-width@^3.0.0'`, then the range edited to `^4.2.0` and `opm update` | the spec is refused as a bare name                                                                                                         | locks 3.1.0 as `sw`; `update` locks 4.2.3, still `sw`; `require('sw')` loads `string-width@4.2.3`                                                                                                       |

**Against the oracle, with nothing bundled.** One node says little about the
solve, so npm's own 68 `dependencies` (the ranges in `npm@10.9.4`'s
`package.json`) were resolved as 68 direct requirements by `opm sync`, and by
`@npmcli/arborist` `buildIdealTree({ add })` with `before` equal to the
evaluation time less 24 hours (the oracle is read-only; platform-only optional
nodes are filtered with `npm-install-checks`):

- arborist: 214 nodes. opm: 191 lock entries, 214 placed copies. The set of
  (install name, version) is **193 on both sides, with no difference either
  way**, alias directories included.
- (path, version) is equal for 189 of the 214 copies. The other 25 are the same
  releases in other places: when a package is needed at two versions, which one
  takes the root differs (`string-width` 5.1.2 at the root in opm, 4.2.3 in
  arborist). Both are trees Node resolves correctly; the planner's tie-break is
  not npm's (`layout-plan.ts`, unchanged here).
- The minimum-release-age gate set aside `ip-address@10.7.4` (published
  2026-10-11T19:34Z) and `p-map@7.1.1` (2026-10-11T15:28Z); opm took 10.7.3 and
  7.1.0, and so did arborist's `before`. No other package of the closure had a
  release inside the window. The run cost 380 requests, 6.46 MB and 48.8 s,
  extraction and layout included.

**Tests that fail without the change.** Each commit of the series names the
tests that fail on the code before it: 37 of 64 for the lock and the solve (the
`@isaacs/cliui` closure, `vitest` next to `tinybench`, every alias form,
`npm:name@tag`), 17 of 26 for the direct alias, 3 of 4 for `why` and the
executables, 2 of 3 for the CLI's words, 3 of 4 for the scoped spelling, 5 of 5
for the archive bounds, and the Rust test for the checker.

**Properties.** `closure-properties.test.ts` draws registries of five packages
with two to four versions each, plain and aliased dependencies, and ranges from
`*` to `^3`. For every closure it checks that each installed requirement has
exactly one edge, to a selected release of the right package that the
ecosystem's own range accepts, under the install name it was written with; that
nothing unreachable is selected; that a name is held at several versions only
when no single release suits all of its edges; that a second resolve, and a
resolve with the registry listed in the opposite order, give the same selection
and the same edges; and that a refusal names who requires what and happens only
when no subset of what the walk found closes (checked exhaustively up to 14
packages). 120 registries in the suite (73 locked, 23 names at several versions,
147 alias edges, 47 refused); a soak of 1,000 with seed 7 (608 locked, 176 names
at several versions, 1,281 alias edges, 392 refused) found no violation. A
differential run over 6,000 random graphs during development showed the planner
places a graph with no alias exactly as it did before (a throwaway script, not
kept).

**Legacy locks.** `legacy-closure.opm.lock.txt` is a lock written by the build
before this change. It parses and serializes to the same bytes, and resolving
the same registry state with the new build writes the same bytes.

**Limits**

- Plain dist-tags (`"foo": "latest"`) are still refused; only an alias names a
  package explicitly enough to resolve a tag for it.
- A required peer dependency that is needed at versions no single release
  satisfies keeps the old who-requires-what refusal (npm's `ERESOLVE`).
- A plain dependency key that differs from its package name only by case is
  placed by the package's canonical (lower-case) name.
- Uninstalling the owner of a shared `.bin` name gives it to the first survivor
  that ships it, by lock key, not to the one npm would pick.
- The solution digest covers the engine's whole selection, before pruning.
- The placement of a package needed at two versions differs from npm's in a
  minority of copies (25 of 214 above); the resolved set is the same.
