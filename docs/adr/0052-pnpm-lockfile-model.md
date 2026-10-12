# ADR 0052: A pnpm lockfile is a model before it is an install

- Status: Accepted
- Date: 2026-10-12
- Relates: [0030](0030-build-versus-buy-for-primitives.md) (a mature YAML
  parser, not our own),
  [0043](0043-one-copy-per-machine-and-a-node_modules-node-can-resolve.md) (the
  layout a snapshot's edges will be placed into),
  [0046](0046-a-lockfile-is-installed-not-re-resolved.md) (the frozen install
  this feeds, and the policy facts it reads from a lock),
  [0049](0049-workspaces-are-a-model-before-they-are-an-install.md) (the members
  an importer is), [0050](0050-workspace-member-links.md) (the link a `link:`
  edge becomes, and the warning that a lock's paths are untrusted input)

## Context

Three of the repositories `opm` has to install are pnpm workspaces, and their
lock is `pnpm-lock.yaml`, which `opm ci` cannot read. The file is not small
(HoBo's has 792 importers) and it is not a list of packages. Reading the four
real locks on this machine and the code of pnpm 10.28.0 that writes them
(`@pnpm/dependency-path`, the lockfile converters, the git, tarball, local and
runtime resolvers) shows what a reader has to get right:

| Lock                |   Bytes | Importers | Packages | Snapshots | Importer links |
| ------------------- | ------: | --------: | -------: | --------: | -------------: |
| HoBo                | 825,879 |       792 |    2,160 |     2,193 |            380 |
| OpenSesame          | 704,467 |        70 |    1,930 |     1,951 |            212 |
| ai-bdd              | 126,489 |         9 |      393 |       393 |             17 |
| OpenSesame/.deepsec |  88,313 |         1 |      306 |       306 |              0 |

1. **Two sections describe one package.** `packages` is keyed by `name@version`
   and says where the bytes are (`resolution`) and what the package claims
   (`engines`, `os`, `cpu`, `libc`, `peerDependencies`). `snapshots` is keyed by
   `name@version(peer suffix)` and holds the edges, so one package appears as
   several snapshots when it was resolved against several sets of peers: 2,160
   packages are 2,193 snapshots in HoBo and 1,930 are 1,951 in OpenSesame. A
   reader that keeps one record per name loses edges; one that keeps one per key
   misses that `packages` is shared.
2. **The key is a small grammar.** `react-dom@18.2.0(react@18.2.0)` has a suffix
   of balanced groups, and the groups nest three deep in the real locks:
   `(@modelcontextprotocol/sdk@1.30.0(@cfworker/json-schema@4.1.1)(zod@4.4.3))`.
   A patched package adds `(patch_hash=...)` in front; a list of peers too long
   to write (`peersSuffixMaxLength`, 1000) is replaced by 32 hex digits. The
   same grammar is the value of every dependency, where a bare `1.2.3` means
   "this dependency's own name at 1.2.3", and `string-width@4.2.3` under the
   name `string-width-cjs` is an alias. pnpm decides which with one rule
   (`refToRelative`); a second reading of it is a second authority.
3. **A source is a string.** A package may come from a registry, a tarball URL,
   a git commit (pnpm writes the id itself, `git+<repo>#<commit>&path:<dir>`), a
   directory, or a runtime with an archive per platform. The key says which and
   `resolution` says what is fetched, and nothing forces them to agree.
4. **The YAML is not free.** The `yaml` library's duplicate-key check compares
   every key with every earlier one: 40,000 packages took 50 s with it on and 3
   s with it off. A megabyte of `[` costs its `parseDocument` 3 s and 916 MB of
   resident memory before it reports the nesting. The file is also Prettier
   formatted in some repositories (a `resolution` broken over four lines).
5. **None of the real locks has an exotic source.** All 4,789 packages in them
   have an integrity-only resolution. Tarball, git, directory and runtime
   resolutions are known from pnpm's code and not from a file here.

## Decision

### Where it lives

1. **`packages/adapter-npm/src/pnpm-lock/`**, beside `lock-tree.ts`, which is
   its sibling for `package-lock.json` and has the same discipline: duplicate
   keys refused, bounded sizes, unsafe paths refused, deterministic output. The
   packages are npm-ecosystem packages, so their PURLs and policy facts are
   npm's. No new workspace (it would need hand-edited lock entries); the package
   gains the `yaml` dependency already in the lock (the same one-line change as
   `opm-project` in ADR 0049) and re-exports the reader from its entry point.
2. **The reader is pure.** Text (or bytes) in, a model or a refusal out. It
   fetches nothing, resolves nothing, reads no file and decides no policy. It
   does not touch the `package-lock.json` reader or the install path.

### What is read

3. `parsePnpmLock(text | bytes, limits?)` reads `lockfileVersion: '9.0'` (the
   format pnpm 9 and 10 write) into `PnpmLock`: `settings` (`autoInstallPeers`,
   `excludeLinksFromLockfile`, `peersSuffixMaxLength`,
   `injectWorkspacePackages`), `overrides`, `catalogs`, `patchedDependencies`,
   `packageExtensionsChecksum`, `pnpmfileChecksum`,
   `ignoredOptionalDependencies`, `time`, and the three that matter:
   - **`importers`**, each with its `dependencies`, `devDependencies` and
     `optionalDependencies` as `{specifier, ref}`, `dependenciesMeta` and
     `publishDirectory`;
   - **`packages`**, with `resolution` as one of `integrity`, `tarball`,
     `directory`, `git` or `variations`, and `engines`, `cpu`, `os`, `libc`,
     `hasBin`, `deprecated`, `peerDependencies`, `peerDependenciesMeta`,
     `bundledDependencies`, `name`, `version`;
   - **`snapshots`**, with `dependencies`, `optionalDependencies`,
     `transitivePeerDependencies`, `optional`, `id` and `patched`.
4. **A dependency path is parsed, not split.** `parseDepPath` finds the suffix
   as pnpm does (the run of balanced groups at the very end, found by walking
   back from the last `)`) and then reads each group: a `patch_hash=` group
   (first only), a 32 digit hash (alone), or a peer, which is itself a
   dependency path. It is checked against pnpm's own functions on generated keys
   (same name, version, patch group, suffix and package key), and
   `formatDepPath` is its inverse. `parseRef` applies `refToRelative` exactly,
   so a value is a `link` (a directory, nothing installed) or a `dep` that names
   the snapshot it resolves to and says whether it was an alias.
5. **The version of a key says its source**: a SemVer 2.0 version is a
   `registry` package, `file:` a path, `http(s)://` a tarball, `git+` an address
   and a full commit, `runtime:` an exact version. Nothing else is a version.

### What is refused

Every refusal is a `PnpmLockError` with the code `INVALID_LOCKFILE` (the code
the `package-lock.json` reader uses), a `reason`, and the path to the fault
(`packages["a@1.0.0"].hasBin`).

6. **The text.** Over `maxBytes`; not UTF-8 (when given bytes); a character YAML
   forbids; an unresolved merge conflict (named as one); not YAML; more than one
   document; a directive; an anchor, alias or tag (pnpm writes none, and an
   alias is how a small file becomes a large one); a mapping key listed twice; a
   mapping key that is not a string (pnpm quotes keys that look like numbers).
7. **The shape.** Any other `lockfileVersion` (older formats are laid out
   differently, and are refused by name rather than half-read); a key pnpm does
   not write in that place; a value of the wrong type (a number where a string
   is wanted says to quote it); a `snapshots` entry that is empty rather than
   `{}`; a `packages` key with a peer suffix.
8. **Names and paths.** A package name that cannot be a directory under
   `node_modules` (`unsafeNameProblem`, the one the layout planner applies); an
   importer id that is absolute, climbs out, has an empty or `.` segment, or is
   inside `node_modules`; a `link:`, `file:` or directory path that is absolute,
   uses a backslash or holds a control character; a `publishDirectory` or patch
   file that leaves the project.
9. **Addresses and digests.** A tarball URL that is not http(s) or carries a
   user name; a git address with a password, or a user other than `git` (over
   ssh, any user without a password); a git commit that is not a full hash; an
   `integrity` that is not exactly one sha1, sha256, sha384 or sha512 token
   whose canonical base64 has the digest's length (no options, no second token).
10. **A key that parses two ways.** Unbalanced or empty groups, text after the
    suffix, a parenthesis inside a version, a `patch_hash` that is not first, a
    hash that is not alone. pnpm reads these as part of the version; a key two
    tools install differently is worse than a refusal.

### The bounds

11. All in `PnpmLockLimits`, each a refusal that names the number:

    | Limit             |   Default | Counts                                      |
    | ----------------- | --------: | ------------------------------------------- |
    | `maxBytes`        |     8 MiB | the text (ten times HoBo's lock)            |
    | `maxNodes`        | 1,000,000 | YAML scalars, mappings and sequences        |
    | `maxDepth`        |        16 | nesting of YAML collections (real locks: 5) |
    | `maxImporters`    |    20,000 | `importers` entries                         |
    | `maxPackages`     |   100,000 | `packages` entries                          |
    | `maxSnapshots`    |   200,000 | `snapshots` entries                         |
    | `maxEntries`      |    50,000 | one other mapping or list                   |
    | `maxKeyLength`    |     8,192 | characters in a key or a dependency path    |
    | `maxStringLength` |    65,536 | characters in any other string              |
    | `maxPeerDepth`    |        32 | nesting of peer groups in one path          |
    | `maxPeerGroups`   |       512 | groups in one path, through every level     |

    They are set from measurement, with a fresh process per input: 0.74 s and 73
    MB resident per megabyte of a realistic lock (6.5 MB took 4.8 s and 478 MB,
    13 MB took 9.6 s and 951 MB), 90 MB per megabyte of one made of tiny entries
    (8.3 MB took 8.8 s and 758 MB). HoBo's complete lock takes 0.7 s and 146 MB,
    of which 77 MB is node. The first defaults (32 MiB) let a 19.7 MB input take
    22 s and 1.7 GB; it is now refused in 1 ms at 95 MB. The text is read
    through the library's lexer and parser one lexeme at a time with the
    parser's stack watched, so a megabyte of `[` stops at `maxDepth` instead of
    costing 3 s and 916 MB; repeated keys are found with a lookup in the map
    being built and the library's own (quadratic) check is off.

### What agrees with what

12. `validatePnpmLock(lock)` returns a report and throws nothing: an importer or
    snapshot dependency that resolves to no snapshot; a snapshot with no entry
    in `packages`; a resolution its key cannot have (registry with a directory
    or git resolution, a `git+` key whose commit or address differs from the
    resolution's, which would make the key policy reads differ from the bytes
    fetched); one dependency under two specifiers; a `workspace:` specifier that
    resolved to a registry package; a `catalog:` specifier with no catalog
    entry; a `patch_hash` nobody declared, a declared hash that differs, a patch
    for a package the lock does not install. It also lists **orphans** (a
    package no snapshot is a variant of, a snapshot no importer reaches), the
    **exotic sources**, and every **link**, an importer's placed on the importer
    it lands on or marked as leaving the root. Problems are counted and the
    first thousand kept. `assertConsistentPnpmLock` is the decision a frozen
    install makes and `readPnpmLock` is parse, validate and that decision.
13. **An exotic source is reported, never fetched.** `exoticSourcesOf` lists
    each package whose resolution is not a bare registry integrity as a
    `tarball` (URL, optional integrity), `git` (repo, commit, path), `directory`
    or `runtime` (variants), with the key, name and version. The policy that
    reads them (ADR 0046 §4) decides; this reader has no opinion.
14. `summarizePnpmLock(lock)`: importers, packages, snapshots; dependency, link
    and alias edges, importers' and snapshots' counted apart; exotic sources by
    kind; the names `packages` holds in more than one version; the packages that
    restrict `os`, `cpu` or `libc`. Every list is in code unit order.

### How it will map to the frozen install

This is the plan the next slice builds on; nothing below is built here.

15. **Selection is by importer.** `--filter`, `--workspace` and `--omit` pick
    importers (the members of ADR 0049) and the dependency lists to follow; what
    is installed is every snapshot reachable from them through `dependencies`
    and `optionalDependencies`. A `link:` edge that lands on a member
    (`report.links[].member`) is that member's link (ADR 0050); a link that does
    not is refused, as is an injected (`file:`) workspace package, until each
    has a place.
16. **A snapshot is a placement, not a name.** Its edges name the snapshot each
    dependency resolves to, so the layout puts the two variants of one
    `name@version` where Node resolves each one's peers to what the lock says
    (ADR 0043), and merges nothing. `packages` is shared: one fetch and one
    proof per `name@version`.
17. **The facts policy reads come from the lock.** The integrity is the proof
    (ADR 0046 §5); a registry package's URL is derived from the name, version
    and the operator's registry, and any other from `resolution` as written;
    `deprecated` is a lifecycle fact; `bundledDependencies` are not fetched on
    their own; `os`/`cpu`/`libc` become the same `TargetPredicate` the npm path
    uses, an `optional` snapshot whose predicate fails is left out with what
    only it needs, and the same mismatch on a snapshot that is not optional is
    an error.
18. **The lock must agree with the project.** Each importer's specifiers must
    equal its `package.json`, and `overrides`, `catalogs`,
    `patchedDependencies`, the two checksums and `settings` must equal what the
    workspace file and the `pnpm` field configure, as
    `pnpm install --frozen-lockfile` requires; a difference is named and
    refuses. The lock's `overrides` are not applied: the lock already holds
    their result.

## Consequences

- `opm ci` still reads only `package-lock.json`. Nothing here changes an
  install.
- A repository whose lock is another format (`lockfileVersion` 5.4, 6.0) is
  refused with the version it has. Reading those would be a second grammar of
  keys (`/name/1.0.0_peers`, `/name@1.0.0(peers)`) and is not built.
- The exotic forms are tested against fixtures written from pnpm's code, not
  from a lock pnpm wrote (`fixtures/locks/pnpm-v9/README.md` says so); the first
  real lock with a git or tarball dependency may differ in a way the code does
  not show, and will be a refusal, not a misreading.
- `yaml` reads about 1.3 MB/s. A lock of the default ceiling takes seconds, and
  the bound exists because of that, not despite it. A faster reader of the same
  subset is possible and was not written: the library is the audited one.
- `snapshots[].patched` is read (a boolean) although pnpm 10.28 does not write
  it, because the brief for this reader listed it; it means nothing here.
- Not done: the mapping above; Windows (paths are the lock's own, POSIX); a lock
  merged by hand with `<<<<<<<` markers is refused by name, and not repaired, as
  pnpm's own merge driver does.
