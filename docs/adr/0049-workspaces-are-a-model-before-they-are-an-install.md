# ADR 0049: Workspaces are a model before they are an install

- Status: Accepted
- Date: 2026-10-12
- Amends [ADR 0042](0042-upm-v1-gaps.md) §2 ("opm has no workspace graph"):
  there is now one, read-only, with no command on top of it yet. (Since
  [ADR 0051](0051-opm-ci-installs-workspace-locks.md), `opm ci` installs a
  workspace lock using this discovery.)
- Relates: [0034](0034-opm-projects-into-native-project-formats.md) (the native
  workspace files stay the person's),
  [0048](0048-one-copy-per-machine-and-a-node_modules-node-can-resolve.md) (the
  layout the members will be linked into),
  [0046](0046-a-lockfile-is-installed-not-re-resolved.md) (a workspace lock is
  refused today), [0047](0047-opm-run-and-exec-run-the-users-own-scripts.md)
  (`--filter` is not there yet; it is, since
  [ADR 0053](0053-opm-run-across-workspace-members.md))

## Context

Four repositories that `opm` has to install and run are workspaces:

| Repository  | Tool | Declared in                | Projects | Links its lock records |
| ----------- | ---- | -------------------------- | -------: | ---------------------: |
| HoBo        | pnpm | `pnpm-workspace.yaml` (16) |      792 |     380 to 89 packages |
| ai-bdd      | pnpm | `pnpm-workspace.yaml` (1)  |        9 |                     17 |
| ts-autocode | npm  | `package.json` (1)         |    4 + 1 |         4 link entries |
| gitlang     | npm  | `package.json` (2)         |    8 + 1 |         8 link entries |

(HoBo is not "about 60 members": its lock has 792 importers, 791 member
directories and the root. The bounds below are set against that.)

`opm ci` refuses every one of them, by name and whole, because a workspace lock
holds links and members it cannot place (ADR 0046 §8; `opm ci` run on this
repository's own `package-lock.json` lists 100 such entries). Installing them
needs three things that have nothing to do with downloading: knowing which
directories are members, knowing which member depends on which, and being able
to say "the members that build `@hobo/mcp`". That is a model, and it can be
written, tested and bounded before any of it touches a `node_modules`. Mixing it
into the installer would make each of its mistakes an install that quietly links
the wrong thing.

## Decision

### Where it lives

1. **Pure logic is in `@openpacker/adapter-core`, `src/workspace/`**: no file
   system, no network, nothing that can be given a path. **Discovery is in
   `@openpacker/opm-project`, `src/workspace/`**, which reads only through
   `@openpacker/project-io`'s handle-relative primitives. No new `packages/*`
   workspace, because that needs hand-edited lock entries and CI runs `npm ci`.
   `opm-project` gains one dependency already in the lock, `yaml`, to read
   `pnpm-workspace.yaml` (ADR 0030: a mature parser, not our own).
2. **The model says what links exist, never how they are made.** An edge is a
   `from` member, a dependency name and a `to` member. Making a symlink is the
   layout writer's.

### What is modelled

3. **Discovery** (`discoverWorkspace(root, {tool?, limits?})`). The declaration
   is `pnpm-workspace.yaml` `packages:` under pnpm's rules or `package.json`
   `workspaces:` (an array, or `{packages: [...]}`) under npm's. With neither it
   returns `undefined`, not an error. With both, pnpm's wins, because pnpm
   ignores `workspaces`, and the discovery says so in `notes`. Nothing is
   searched upward: the caller names the root. A `pnpm-workspace.yaml` with no
   `packages` is the root alone, as pnpm defaults it (`["."]`). Members come
   back as `{dir, root, name, nameFromDirectory, manifest}` in one order
   everywhere: the root, then by directory in code-unit order (not pnpm's
   `lexCompare` order and not npm's pattern-then-locale order; neither is relied
   on).
4. **Graph** (`buildWorkspaceGraph(members, {linkPolicy, ranges})`). Edges from
   all four dependency lists, a key listed in several counted once under the
   list that wins (`dependencies`, `optionalDependencies`, `devDependencies`,
   `peerDependencies`: pnpm's merge). **`linkPolicy` is required and has two
   values**: `workspace-protocol` (only `workspace:`, `link:` and `file:` to a
   member's directory; pnpm's default since v9) and `satisfied-range` (also a
   plain range the member's version satisfies; npm always, pnpm with
   `link-workspace-packages`). `linkPolicyOf(discovery)` gives each tool's own
   default and reads pnpm's setting from `pnpm-workspace.yaml` only, never
   `.npmrc`; a caller who knows better passes the policy. A member that lists
   itself is kept apart (`selfEdges`): not linked, not ordered. Queries:
   `dependenciesOf`, `dependentsOf` (direct or transitive, per list).
5. **Order** (`topologicalOrder(graph, {cycles, fields?, among?})`). `cycles` is
   required: `'error'` refuses with every cycle named as `a -> b -> a` (pnpm's
   `--disallow-workspace-cycles`), `'tolerate'` reports them and orders the
   members of a cycle together (pnpm's default, a warning). Cycles are the
   strongly connected components, found without recursion, so a cycle that
   pnpm's longest-cycle search would report in pieces is reported once. A cycle
   closed only by `devDependencies` is reported with `runtime: false`, and
   ordering with `fields` left at the runtime lists does not see it. npm orders
   nothing (`npm run -ws` runs in declaration order), so there is no npm mode.
6. **`workspace:` specifiers**: `*`, `^`, `~`, `1.2.3`, `^1.2.3` and any other
   range, `name@...` (the alias), `../path` and `./path`. A package with no
   version counts as `0.0.0`, as pnpm installs it; `*`, `^` and `~` accept any
   version, prereleases included. A form this does not support, or one that
   names nothing or a version the member does not have, fails with the specifier
   and the member in the message. `publishedDependencies` is the rewrite pnpm
   applies when it packs (`workspace:*` is `1.2.3`, `workspace:^` is `^1.2.3`,
   an alias becomes `npm:name@...`). It was run against pnpm's own converter,
   lifted out of pnpm 10.28.0, on 21 forms over a real layout: 20 agree
   character for character, and the 21st (a compound peer range pnpm
   half-rewrites) is refused.
7. **Filters** (`parseFilter`, `selectMembers`): the grammar of `pnpm --filter`
   that HoBo's scripts and CI use, and the other repositories' scripts need: a
   name, a `*` glob, `./dir`, `{glob}`, `name...`, `...name`, `^` to leave the
   member out, `!` to subtract, a bare name that is the one scoped package of
   that name. A selector that matches nothing is an error unless `allowEmpty`.
   `[since]` is a typed `WORKSPACE_FILTER_UNSUPPORTED`, not a guess.
   `selectNpmWorkspaces` is `npm -w`: a name, a directory, or the directory
   above.

   **A directory selector is a pattern, not a subtree.** pnpm 10 reads
   `./packages/a` and `{packages/a}` with `use-glob-dir-filtering`, which is on
   unless the setting `legacy-dir-filtering` turns it off (pnpm 10.28.0 sets
   `useGlobDirFiltering: !config.legacyDirFiltering`). So `./packages/a` selects
   the member whose directory is `packages/a` and not the member inside it,
   `./packages` selects nothing when no member lives in `packages`, and
   `./packages/*` or `{packages/**}` select by pattern. Reading a directory as
   "this directory and everything under it" is the legacy behaviour: the pnpm
   10.28.0 command line, run over a workspace of `packages/a`,
   `packages/a/inner` and `packages/b`, selects nothing for `./packages` and
   only `packages/a` for `./packages/a`. `legacyDirFiltering: true` on the
   filter's context asks for the legacy reading, where a wildcard is an ordinary
   character; `.npmrc` is not read, so the caller says which. The grammar is
   pinned to the real command line, `pnpm --filter=... ls`, on 460 selector
   lists from the root and from three directories below it, with and without the
   legacy setting (`workspace-filter-oracle.json`, replayed by
   `workspace-filter.oracle.test.ts`). The model reads 438 of the 460 and
   selects what pnpm selected on each. It refuses the other 22, by name, in
   three kinds: a path that leaves the workspace root (16; pnpm matches nothing,
   and under the legacy setting a path above the root takes every member),
   braces in a directory (2: `./packages/{a,b}`), and a character class or an
   extglob (4: `./packages/[ab]`, `@(a|b)`), which pnpm's matcher reads as a
   pattern.

### Where npm and pnpm differ, as found

The patterns were put to the tools themselves on 115 pattern lists over one
tree: pnpm 10.28.0 by running `pnpm ls -r` over a `pnpm-workspace.yaml` that
holds them (so its `findPackages` and the tinyglobby 0.2.14 bundled in
`pnpm.cjs`), npm 10.9.4 through `@npmcli/map-workspaces` 4.0.2 over glob 10.4.5.
The answers are
`packages/adapter-core/test/fixtures/workspace-glob-oracle.json`; the scripts
that produced them, and how to run them again, are beside it in
`workspace-oracle/`. The model reproduces each tool on every list it accepts,
except the eight lists of the last row of the table, where it keeps npm's
reading and a test says so; it refuses seven lists on purpose, each with a test.

| Matter                         | npm                                                     | pnpm                                                                                                  | Here                                                                 |
| ------------------------------ | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Which file                     | `package.json` `workspaces`                             | `pnpm-workspace.yaml` (ignores `workspaces`)                                                          | per tool                                                             |
| The root                       | not a workspace                                         | always a project when it has a manifest                                                               | a member (`root: true`); a pnpm pattern naming it adds nothing       |
| `!` after the patterns it hits | order matters; a later pattern the `!` matches lifts it | applies to the whole list, whatever the order                                                         | each tool's own, `npm` bug-for-bug (`applyNpmNegations`)             |
| Leading `/`                    | read as the root                                        | an absolute path; selects nothing                                                                     | npm: the root; pnpm: refused (`ESCAPES_ROOT`)                        |
| A `.` segment mid-path         | selects nothing                                         | dropped                                                                                               | refused in both (`PATTERN_INVALID`)                                  |
| A nameless member              | named for its directory (`@s/b` under an `@s` parent)   | no name; addressed by path                                                                            | per tool (`nameFromDirectory`)                                       |
| Two members, one name          | error                                                   | allowed when their versions differ                                                                    | error in both, naming both paths                                     |
| Manifest files                 | `package.json`                                          | also `package.yaml`, `package.json5`                                                                  | `package.json` only; a pnpm member with only the others is refused   |
| Symbolic links                 | followed (a `*` step resolves through one)              | followed (tinyglobby)                                                                                 | never followed: see below                                            |
| Case                           | insensitive on macOS and Windows                        | sensitive                                                                                             | sensitive                                                            |
| Cycles                         | none: `-ws` runs in declaration order                   | warns, or errors with `--disallow-workspace-cycles`                                                   | both modes, required                                                 |
| `workspace:` specifiers        | `EUNSUPPORTEDPROTOCOL`                                  | the protocol's author                                                                                 | parsed for any tool: the locks that carry them are pnpm's and Yarn's |
| Plain range, member satisfies  | linked                                                  | linked only with `link-workspace-packages`                                                            | `linkPolicy`                                                         |
| A hidden name right after `**` | selected (`packages/**/.hid` selects `packages/.hid`)   | not selected when the `**` matched no directory (tinyglobby 0.2.14: `**/.*` skips a top-level `.top`) | npm's reading, kept on purpose and pinned by a test: see below       |

Agreed by both, and tested: `*` and `?` never match a name that starts with ".",
a literal "." can; `**` stands for zero or more directories (so `p/**` selects
`p` itself when it has a manifest, but see the last row) and never enters one
that starts with "."; `{a,b}` expands, nested and across "/"; `node_modules` is
never visited; `!x` removes the member directory `x`, and `!x/**` removes it and
what is below.

The last row is a quirk of the globber pnpm bundles, recorded as eight lists in
the golden file (`workspace-glob-known-differences.json` names them). On those
lists a segment that names a hidden directory, directly after a `**`, matches
only when the `**` stood for at least one directory: `packages/**/.hid` does not
select `packages/.hid`, `pkg/**/.dot` selects `pkg/a/.dot` but not `pkg/.dot`,
and `**/.*` leaves out a top-level `.top`. The model keeps the reading both npm
and the plain meaning of "zero or more directories" give. It is a choice, not an
oversight: it only concerns a pattern that names a hidden directory through a
`**`, and refusing that shape would turn away patterns npm accepts. The tests
assert both halves, that the model selects what npm selected and that pnpm's
recorded answer is different, so the day pnpm changes, or the model does, one of
them fails.

### Bounds and refusals

8. Every bound is a field of `WorkspaceLimits`, has a default and a hard ceiling
   (`resolveWorkspaceLimits` refuses a value past it), and ends in
   `WORKSPACE_LIMIT_EXCEEDED` naming the number:

   | Limit                                          | Default |
   | ---------------------------------------------- | ------: |
   | members, the root included                     |   4,096 |
   | directory entries read                         | 100,000 |
   | directory depth below the root                 |      32 |
   | patterns in a declaration                      |     256 |
   | characters in a pattern                        |   1,024 |
   | alternatives a declaration's `{a,b}` expand to |     256 |
   | one `package.json`                             |   1 MiB |
   | all members' `package.json` held at once       |  64 MiB |
   | `pnpm-workspace.yaml`                          |   1 MiB |
   | entries in one dependency list                 |  10,000 |

   HoBo, the largest of the four, reads 23 directories and 911 entries and holds
   792 members. Wildcard matching is a two-pointer walk, not a regular
   expression, so no pattern backtracks; a YAML file is limited to 64 aliases.

9. Refused, each with a code and a test: a pattern that leaves the root (`..`, a
   drive letter, and for pnpm an absolute path), or uses a character class, an
   extglob, a backslash, a brace with no comma or a range; a name that is not a
   package name (the set the `node_modules` layout accepts, so a member can
   always be laid out); two members with one name; a `package.json` that is not
   UTF-8 JSON, repeats a key (as the lock reader refuses), has a field of the
   wrong type or a version that is not SemVer 2.0; a manifest, root or member,
   that is a symbolic link; a directory a pattern reaches whose name no
   directory handle can take (a backslash or a control character), as
   `WORKSPACE_PATH_UNSAFE` naming the directory.
10. **A symbolic link is never followed.** A pattern that _names_ one (it is the
    member, or a directory the pattern goes through by name) is refused with the
    path; one met while a `**` searches is passed over and listed in
    `skippedLinks`. Both tools follow links; a member that is only reachable
    through one would otherwise be linked from a place the repository's own
    layout does not hold. Every directory is opened relative to its parent's
    handle without following, so a directory swapped for a link between the
    listing and the open is refused too. A test makes that swap between the two
    calls, once for a link and once for a file, and fails when the no-follow
    open or the directory-only open is taken out; the platform that reports the
    open of a link as `ELOOP` (macOS) is covered by a test that raises it.

### Deliberately out of scope

Install scripts of members; `[since]` and any git-based selection; catalogs
(`catalog:`) and `pnpm.overrides` / `resolutions` (HoBo's lock has 380 links;
375 are `workspace:*` and five are plain ranges the root's `overrides` rewrite,
which only appear here under `satisfied-range`); `.npmrc` settings; `injected`
workspace packages; `package.yaml` and `package.json5` members; `--filter-prod`;
Yarn and Bun workspaces; searching upward for the root;
`link-workspace-packages: deep`, which links transitive registry dependencies;
an `npm:` alias written outside `workspace:`, which is a registry dependency
under both policies (npm never links one, and pnpm does only with
`link-workspace-packages`).

## Consequences

Measured on 2026-10-12 against the four repositories as they stand, read-only,
with `discoverWorkspace` and `graphOfWorkspace` (linux-x64, Node 22.22.0):

| Repository  | Members found | Lock says      | Edges (`workspace-protocol` / `satisfied-range`) |   Time |
| ----------- | ------------: | -------------- | -----------------------------------------------: | -----: |
| HoBo        |           792 | 792 importers  |                                        375 / 380 | 183 ms |
| ai-bdd      |             9 | 9 importers    |                                          17 / 17 |   6 ms |
| ts-autocode |             5 | 4 links + root |                                            0 / 5 |   2 ms |
| gitlang     |             9 | 8 links + root |                                           0 / 22 |   3 ms |

The 380 under `satisfied-range` is the lock's 380 `link:` versions, to the same
89 distinct packages. Under pnpm's own policy there are 375 edges, because five
of them are plain ranges (`ts-autocode-grounding: 0.1.0` and four more) that
pnpm links only through the root's `overrides`; overrides are out of scope, so
the difference is stated and not reproduced.

Limits that remain:

- Nothing installed from this when it was written: `opm ci` refused a workspace
  lock, `opm run` had no `--filter`, and there were no per-member
  `node_modules`. `opm ci` installs a workspace lock as of
  [ADR 0051](0051-opm-ci-installs-workspace-locks.md), and `opm run` and
  `opm exec` take `--filter` since
  [ADR 0053](0053-opm-run-across-workspace-members.md).
- Ranges are read by the range parser `adapter-core` already has, which is not
  node-semver on partial versions. Put to npm's own semver (7.7.2,
  `satisfies(version, range, true)`) on 289 ranges and 23 versions, 6,647 pairs
  (`workspace-range-oracle.json`), the engine agrees on 203 ranges and differs
  on 86, 783 pairs, in these classes:
  - `=` before a partial or wildcard version (16: `=1`, `=1.2`, `=1.x`): the
    engine reads the zero-filled version, semver the whole line;
  - `^` before a partial version whose major is 0 (5: `^0`, `^0.0`, `^0.x`,
    `^0.0.x`, `^0.x.x`): `^0` is `=0.0.0` here and `<1.0.0` in semver;
  - `~` before a version whose minor is a wildcard (6: `~1.x`, `~1.*`,
    `~0.x.x`);
  - `>` before a partial or wildcard version (19: `>1`, `>1.2`, `>0.x`) and `<=`
    before one (16: `<=1`, `<=1.x`): the engine compares with the zero-filled
    version, semver past the whole line (`>1` is `>=2.0.0`, `<=1` is `<2.0.0`);
    `>*`, `>x`, `<*` and `<x` (and their `X` forms) match every release version
    here and none in semver;
  - a partial version with a leading `v` after any operator (16: `v1`,
    `>=v1.2`), which the engine does not read as a range at all (`v1.2.3`
    agrees);
  - a hyphen range with wildcard ends (`1.x - 2.x`), not read as a range either;
  - an operator with no version (`^`, `>=`), read as `*` here and rejected by
    semver;
  - the two compound ranges in the list that contain the above (`>1 <=2`,
    `>=1 <=2 || 0.x`).

  Every full `x.y.z` range, `*`, `||`, hyphen range between full versions and
  prerelease range in the list agrees on every pair, as do a bare partial (`1`,
  `1.x`, `0.x`), `<` and `>=` before one, and `^` and `~` before the partials
  not named above. A range in a class is decided by the parser, not by
  node-semver: a `workspace:` range may be refused where pnpm accepts it (or
  accepted where it refuses), and a plain range may fail to link a member npm
  would link, or link one it would not. Fixing it belongs to the parser, which
  resolution shares, not to the workspace model;
  `workspace-ranges.oracle.test.ts` pins the 86 and their classes, so the fix
  fails it and sends these figures to be corrected, and so does a new
  difference.

- A member's version must be strict SemVer 2.0. node-semver also accepts
  `v1.0.0` and, loosely, `=1.0.0` and `01.0.0`; a workspace with one is refused,
  naming the file.
- Case-insensitive matching (macOS, Windows) is not modelled; the Windows and
  macOS paths of the underlying handle I/O are as verified as in ADR 0045.
- The entry bound is checked once a directory has been listed, and a listing is
  read whole, so one directory holding millions of entries is listed before it
  is refused.
- A hostile tree can still make the walk match each of up to 100,000 directories
  against up to 256 pattern alternatives; the bound is on entries, not on time.
