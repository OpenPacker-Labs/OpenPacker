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
9. **Edges.** `dependencies` is unchanged: the keys an entry requires, sorted. A
   requirement whose install name is not the target's package name adds
   `aliases: { "<install name>": "<key>" }` to the entry that has it (sorted by
   install name, written after `dependencies`, absent when empty), and the key
   is also in `dependencies`, so everything that walks `dependencies` for
   reachability keeps working. A direct requirement installed under an alias has
   `installName` on its entry. An entry's own `purl` and `version` are the
   target's: the bytes, the bins and the policy are the real package's.
10. **A direct alias.**
    `opm add string-width-cjs@npm:string-width@^4.2.0 -e npm` writes
    `[packages.string-width-cjs]` with `purl = "pkg:npm/string-width"`,
    `version = "^4.2.0"` and `install_name = "string-width-cjs"`, and
    `package.json` gets `"string-width-cjs": "npm:string-width@^4.2.0"`.
    `--alias` keeps meaning the local label it always was.

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
    - `remove` and `sync` reach through `dependencies` and `aliases` both.
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

## Consequences

Filled in with measurements from the acceptance runs, below.
