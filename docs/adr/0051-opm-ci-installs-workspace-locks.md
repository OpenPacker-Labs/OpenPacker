# ADR 0051: `opm ci` installs a workspace lock

- Status: Accepted
- Date: 2026-10-12
- Amends [ADR 0046](0046-a-lockfile-is-installed-not-re-resolved.md) §8 (the
  refusal of workspace members and links) and the limit that repeated it;
  [ADR 0048](0048-one-copy-per-machine-and-a-node_modules-node-can-resolve.md)
  (a member's `node_modules`)
- Relates: [0049](0049-workspaces-are-a-model-before-they-are-an-install.md)
  (the model whose discovery this uses), [0050](0050-workspace-member-links.md)
  (the link it writes, and the warning that a lock's `resolved` is untrusted
  input)

## Context

`opm ci` refused every npm workspace lock, listing its links and members
(ts-autocode: 4 links and 4 members, exit 3; this repository: 100 entries). ADR
0049 made the workspace a model and ADR 0050 made a member's link a thing the
layout can write. What was missing is the install itself, and three things that
are not downloading:

1. A workspace lock is three statements of one fact: the root entry's
   `workspaces` patterns, an entry per member under its own directory, and a
   `link: true` entry per member under `node_modules`. A version only one member
   wants sits inside that member (`packages/x/node_modules/a`), which no part of
   `opm ci` had a place for.
2. A `link: true` entry is a request for a symlink, written by whoever wrote the
   lock. ADR 0050 allows one kind of link and says a later step "must treat a
   lock's `resolved` as untrusted input and not take the prefix walk for an
   authorisation of it". Nothing yet checked a lock's links against anything.
3. `npm ci` has workspace flags (`-w`, `--include-workspace-root`,
   `--workspaces`), and the rules for what they install are arborist's, not
   obvious from the lock.

## Decision

### The one reader reads the workspace too

1. `lock-tree.ts` is still the one reader of `package-lock.json`. It now also
   yields `workspace` (`lock-workspace.ts`): the members, a link per member, and
   the registry packages inside members (each keeps the member its chain starts
   in, `LockEntry.member`). `entries`, `links` and `foreign` keep their meaning,
   so the capture that predates this sees the lock as before.
2. **The lock's own member list decides what is a member**, not the disk: a key
   outside `node_modules` that the root entry's `workspaces` patterns select
   (the model's own matcher, npm's rules). A key that is not selected, and not
   inside a member, is not something `opm ci` can install.
3. **A link is accepted only when** its key is `node_modules/<name>` directly in
   the project, its `resolved` is a relative path in normal form that names a
   member of that list, `<name>` is that member's own name, and the text the
   layout would write passes ADR 0050's rules (`memberLinkProblem`). Anything
   else is refused by path and reason, and nothing is installed:

   | A `link: true` entry that                                        | Refused as                                                  |
   | ---------------------------------------------------------------- | ----------------------------------------------------------- |
   | leaves the project (`../x`), is absolute or not in normal form   | `a link that points at …, which leaves the project root`    |
   | names a directory that no pattern selects (`vendor/x`)           | `a link to vendor/x, which is not a workspace member (…)`   |
   | is named other than for its member (`alias`)                     | `a link named alias to the member one`                      |
   | is inside a package or inside a member                           | `a link inside a package` / `inside the workspace member …` |
   | the layout's link rules refuse (`.opm`, `node_modules` segments) | `a link … that the layout's link rules refuse (…)`          |

   The same list names a key that is not a member (`vendor/x`), a registry
   package inside a directory that is not a member, a member recorded as a link,
   and a package **bundled in a member**: a member is a directory, so there is
   no archive to take a bundled copy from. Two members with one name, a member
   with no link of its own, and patterns that cannot be read are errors, not
   refusals: the lock contradicts itself. A member's **own** link that is the
   offender (`node_modules/one` with `resolved: "../../.."`, or pointing at a
   directory no pattern selects) is a refusal that names that link; "has no
   link" is said only when the lock holds no link of that name at all.

4. Nothing nested is linked. npm writes only root-level links for workspaces; a
   link inside a package or a member (what a `file:` dependency on a member
   under another name would give) is refused rather than guessed.

### The lock is held to the files it was written from

5. A host that sees a format with a `workspaceTool` can discover the workspace
   on disk (ADR 0049's discovery: bounded, never following a link) and hands the
   lock reader a function that does it. The reader asks only when there is a
   workspace to hold the lock to, the lock listing members or `package.json`
   declaring `workspaces`; a selection (`-w`, `--workspaces`) needs the members
   at once. Discovery reads every manifest more strictly than `npm ci` does (a
   version must be SemVer 2.0, a key may not repeat), and a project with no
   workspace is installed exactly as it was before this decision. **The members
   the lock lists and the members the project declares must be the same
   directories, names and versions**, or the install is an error that names both
   lists and each difference, as `npm ci` refuses. Each member's `package.json`
   is then held to the lock's entry for it as the root's is: a dependency added
   or dropped, a spec the locked version no longer satisfies (a dependency on
   another member is judged against that member's version), and a dependency the
   lock has no entry for are named. Optional dependencies may be absent from a
   lock, as for the root. The project's own dependency on a member by a plain
   range finds the member's link (before, it found nothing).
6. This is checked before anything is fetched or written, after the refusals of
   3 (which are the whole answer when there are any).

### What is installed, and what the flags select

7. Members are **never fetched and their scripts never run**; they are linked
   (ADR 0050) from `node_modules/<name>` to their directory, with the lock's own
   placement. Registry packages are installed as before (integrity before use,
   the shared store, bounded fetch from the lock's origins, host filtering,
   `--omit`), at the path the lock gives, which may be inside a member.
8. The graph a dependency is resolved in is the lock's: from a package's
   directory, its own `node_modules`, each ancestor's, and for a package inside
   a member the project's last. The project and each member are tops, always
   installed. A name that resolves to no package but to a member's link is an
   edge to the member. Flags (`dev`, `optional`, `peer`), `--omit`, the platform
   check and `optionalSet` are the lock's and npm's, unchanged; they apply to a
   member's dependencies like any other.
9. The flags are `npm ci`'s, read from arborist (`reify` `_diffTrees`,
   `Diff.calculate`, `workspaceDependencySet`):

   | Flag                                    | Installs                                                                                                                                                                            |
   | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | none                                    | the whole lock                                                                                                                                                                      |
   | `-w <name\|dir>` (repeatable)           | those members (a name, a directory, or the directory above), what their dependency lists reach, the members those depend on and what they reach; not the project's own dependencies |
   | `-w … --include-workspace-root`         | the same, and the project's own dependencies (its edges to members' names are workspace edges and are not followed)                                                                 |
   | `--include-workspace-root` alone        | the whole lock, as in npm                                                                                                                                                           |
   | `--workspaces`                          | every member, as `-w` for all; not the project's own dependencies                                                                                                                   |
   | `--workspaces=false`, `--no-workspaces` | the project's own dependencies and no member and no link to one                                                                                                                     |

   A package outside the selection is left out (`skipped`, kind `workspace`) and
   is not platform-checked. Flags that cannot go together (`--workspaces` with
   `--no-workspaces`, `--workspaces=false` with `-w`), a selection that names no
   member, a value other than `true`/`false`, `-w` with no value, and a stray
   argument (including the `--workspaces false` npm accepts) are refused with
   the invalid-input exit status before anything is written. `--path` must be
   the workspace root: nothing is searched upward, so npm's implicit workspace
   (running inside a member) does not exist here.

10. **`npm ci` clears every workspace's `node_modules`, whichever it then
    installs** (`lib/commands/ci.js` removes the entries of each workspace and
    the root), and so does this: the project's, and each member's by a walk down
    from the project root that follows no link (`removeBelow`; `removeTree`
    would follow a symlinked ancestor, and a member's directory comes from a
    lock).

### A member's own `node_modules`, and its executables

11. A package whose place lies under a member is written in that member's
    `node_modules` by the same no-follow walk from the project root (a link or a
    file on the way is `UNSAFE_PATH`; a place under a directory the layout was
    not given is refused). That `node_modules` has its own `.bin` for what is in
    it and its own `.opm-layout.json`, so a later layout removes what opm wrote
    there and leaves what it did not.
12. **A member's own executables are shimmed in the project's `.bin`**, a shim
    and never a link, where npm links them: arborist's `#createBinLinks` links
    the bins of a link node into the `node_modules/.bin` of the directory the
    link sits in, which for a workspace member is the project's. A member's own
    `.bin` holds the bins of the packages nested in that member and not the
    member's own, nor another member's. The shim addresses the member's
    directory. A script that is not there yet (a member is built after the
    install) is shimmed anyway, running under `node`; once the script exists its
    first line decides. A name that a member and a package both declare goes by
    the rule the packages already had: a direct requirement keeps it, a member
    counting as direct, and between two direct ones the owner whose name sorts
    first keeps it; the other is skipped with who kept it. So a member does not
    always win: a direct package named `aaa` outranks a member named `member`.
    npm's own order for two bins of one name is not observed here (nothing runs
    npm), so this is a deterministic rule and not a claim about npm. An unsafe
    name, a script outside the member, or a directory a shim cannot carry is
    skipped, with the reason.

### What a real lock needed on the way

13. `@mistralai/mistralai@2.4.1` is in ts-autocode's lock and has five paths
    longer than a ustar header holds, which its tar writes as pax extended
    headers. The materializer refused the header as an unsupported entry type,
    so no install of that lock could finish. It now reads them: a record's
    `path` names the entry after it and is checked like any name; `size` is
    accepted only when it repeats the entry's own header (npm writes one with
    every pax header) and is refused otherwise; a global header may carry
    neither; a header is bounded to 64 KiB; two in a row, one with no entry
    after it, and a record that is not exactly `<length> <key>=<value>\n` are
    malformed.

## Consequences

Measured on 2026-10-12, linux-x64 (glibc 2.39), Node 22.22.0, a 4-CPU VM other
work was using (load average 11 to 15), against registry.npmjs.org through the
sandbox proxy. The oracle is `@npmcli/arborist` 8.0.1 `loadVirtual` (npm 10.9.4)
with `checkPlatform`, `optionalSet`, reify's `omit` test and the filter set
`Diff.calculate` builds for `--workspace`
(`packages/adapter-npm/test/workspace-oracle/install-oracle.cjs`, read-only on
the system npm): it compares the set of (path, name, version, link target) that
arborist would install with a walk of what is on disk, and looks each member's
declared dependencies up from the member's directory.

The oracle is a tool to run by hand against a real lock, and it is also replayed
without npm: `packages/opm-project/test/frozen-install.oracle.test.ts` installs
a fixture workspace that has what no real lock at hand has (a package inside a
member, one inside a package inside a member, a development and an optional
dependency of a member, an optional package no platform takes) with 10 option
sets (`--omit`, `-w`, `--include-workspace-root`, `--workspaces`,
`--workspaces=false`) and compares the result to the sets arborist gave,
recorded in `test/fixtures/workspace-install-oracle.json` by
`install-oracle.cjs --print-expected`. With the dev omission switched off for
packages inside a member, 3 of the 10 fail.

| Measured                                                                                                                                           | Result                                                                                                                                                                                                |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ts-autocode before this change                                                                                                                     | exit 3, 8 entries named (4 links, 4 members), nothing written                                                                                                                                         |
| ts-autocode, `opm ci`                                                                                                                              | 438 packages and 4 links; against the oracle 442 expected, 442 installed, 0 differences either way                                                                                                    |
| `--production`, `-w ts-autocode-training`, `-w … --include-workspace-root`, `--workspaces`, `--workspaces=false`, `--no-workspaces --omit dev`     | 185, 138, 289, 184, 288, 31: each equal to the oracle, 0 differences                                                                                                                                  |
| ts-autocode, each member's declared dependencies                                                                                                   | 16 found where the lock says (the other member included), 14 also `require.resolve` to a file inside that directory; the other 2 have no `require` entry (an ESM-only `exports`), 0 resolve elsewhere |
| this repository, `opm ci` in a clean scratch worktree                                                                                              | 263 packages and 50 member links, 313 expected, 313 installed, 0 differences; 267 edges found where the lock says                                                                                     |
| after the move to the base that added packslip: this repository again, 53 members                                                                  | 268 packages and 53 links, 321 expected, 321 installed, 0 differences; 291 edges found where the lock says; second project 4,820 KB of 385,504 KB (1.25%), 11.3 s with every archive in the store     |
| this repository, `--production`, `-w @openpacker/project-io`, `--workspaces=false`, `-w packages/adapter-npm -w apps/opm --include-workspace-root` | 119, 11, 71, 128: each equal to the oracle                                                                                                                                                            |
| built and tested with only `opm`                                                                                                                   | `opm ci`, then `opm exec turbo -- run build --filter=@openpacker/adapter-npm...`, then `opm run test`: adapter-npm 344 passed, project-io 540 passed                                                  |
| cold: empty store, 103.1 MB fetched                                                                                                                | 56.7 s                                                                                                                                                                                                |
| partly warm: 62 of 262 archives already in the store, 86.2 MB fetched                                                                              | 38.3 s (all 262 in the store, for a second project: 12.0 s)                                                                                                                                           |
| a second project from the same lock                                                                                                                | adds 4,700 KB to the first project's 384,252 KB (1.22%): its directories and nothing else (`du -sk` over all paths in one invocation)                                                                 |
| reading and planning a synthetic lock of 10,001 entries and 800 members                                                                            | 166 ms to read, 603 ms to plan, 231 ms to hold to the manifests                                                                                                                                       |

The unit and integration tests need no network: a registry stand-in serves
archives built in the tests.

Costs and limits, stated so nobody finds them by surprise.

- **The brief for this work expected a member's bins in "that member's
  `node_modules/.bin`" where a member depends on another.** The arborist source
  puts a link's bins in the `.bin` beside the link, and every workspace link is
  in the project's `node_modules`; so the other member's executable is in the
  project's `.bin` and reachable from a member by the `PATH` `npm run` builds
  (every ancestor's `.bin`). This was read from `bin-links` 5.0.0 and arborist
  8.0.1, not observed by running `npm ci` (nothing here installs with npm).
- **`--path` is the root.** npm walks up from a member to find the workspace and
  makes the member the selection; `opm ci` does not search upward (ADR 0049).
- **Only root-level links, only by the member's own name.** A `file:` dependency
  on a member under another name, and a link inside a package, are refused.
- **A member's shim runs under `node` until the script exists.** npm's link
  follows the script's shebang at run time; a shim cannot, so a member bin whose
  script is built later and asks for another interpreter (`#!/bin/sh`) is run by
  `node` until `opm ci` is run again.
- **`workspace:` protocol, pnpm and yarn locks, `[since]`, catalogs and
  overrides** are not part of this (ADR 0049's list); the pnpm lock is another
  reader behind the same `readFrozenLock` seam.
- **The platform differences are the ones of ADR 0050.** The junction (Windows)
  and `symlinkat` (macOS) paths are the code of ADR 0050 and the Windows and
  macOS legs of CI are the first evidence for them; the new tests that run a
  shim use `sh` and are skipped on Windows, the ones that compare a link's text
  skip it there (a junction holds an absolute path). Nothing in this change has
  run on Windows or macOS.
- **The oracle reads the lock; it does not run `npm ci`.** Differences in what
  npm's reify does that are not in the arborist functions named above would not
  show. Lifecycle scripts, which `npm ci` runs and this does not, are the known
  one (ADR 0046 §9).
- **A member whose `package.json` has a `workspaces` of its own** (nested
  workspaces) is read as a member and nothing inside it is searched; npm does
  not nest workspaces either.
