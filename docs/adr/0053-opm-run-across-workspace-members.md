# ADR 0053: `opm run` and `opm exec` across the members of a workspace

- Status: Accepted
- Date: 2026-10-12
- Amends [ADR 0047](0047-opm-run-and-exec-run-the-users-own-scripts.md): its
  "Limits" ("there are no workspaces here: no `--filter`, no `--workspace`") is
  retired, and §3 gains one name (`node`). Everything else in 0047 holds for
  each member exactly as it holds for the project.
- Amends [ADR 0049](0049-workspaces-are-a-model-before-they-are-an-install.md):
  "`opm run` still has no `--filter`" is no longer true. The model is unchanged.
- Relates:
  [0043](0043-one-copy-per-machine-and-a-node_modules-node-can-resolve.md) (the
  `.bin` shims a member's `PATH` leads with),
  [0050](0050-workspace-member-links.md) (the links a member resolves its
  siblings through)

## Context

ADR 0049 made a workspace something `opm` can read: which directories are
members, who depends on whom, which members a `--filter` selects. Nothing used
it. The repositories to be moved (HoBo, ai-bdd, ts-autocode, gitlang) run their
builds and tests across members with `pnpm --filter`, `pnpm -r`, `pnpm exec` and
`npm run -w`, and ADR 0047's `opm run` reads one `package.json`.

What those repositories (and OpenSesame, which is a pnpm workspace too) call was
counted, not guessed: every `pnpm`, `npm` and `npx` command line in their
`package.json` scripts, GitHub workflows, shell scripts and git hooks,
Dockerfiles, devcontainer and spawn-style calls with a literal argument list
(HoBo's vendored `external/` excluded; three matches inside printed text
dropped), at the commits listed in
`apps/opm/test/fixtures/workspace-run-forms.json`:

| Group                                                                  | Command lines | Share |
| ---------------------------------------------------------------------- | ------------: | ----: |
| `run` and `exec`, with or without a workspace option, and script words |           382 | 79.3% |
| `npx` and `dlx`                                                        |            27 |  5.6% |
| `install`, `ci`, `publish`, a version query: other commands            |            73 | 15.1% |
| Refused outright                                                       |             0 |     0 |
| Total                                                                  |           482 |       |

(34 distinct forms; the guide prints them all, with how often each occurs in
which repository and what `opm` does with it. `apps/opm/test/run-forms.test.ts`
reads every one of them the way the process entry does, so a change that turns
one into a usage error fails.) Three things in the counts decided the rest:

- 147 of the 382 are not `run` at all but a **script's name where a command
  goes** (`pnpm typecheck`, `pnpm --filter @opensesame/pages build:profile`,
  `pnpm test`); pnpm, like npm for `test`, `start` and `stop`, takes the word as
  a script and, with no member selected, failing that as a program in
  `node_modules/.bin` (checked against pnpm 10.28.0).
- pnpm puts its workspace options **before** the command
  (`pnpm --filter a run build`, `pnpm -r exec tsc`), npm puts its own **after**
  (`npm run build -w @gitlang/web`).
- Seven lines are `pnpm exec node ...`; `node` is not in any `.bin`.

## Decision

### Options

`opm run [<script>]` and `opm exec <bin>` read these, in either tool's spelling
(options for `exec` go before the bin, because everything after it is the
bin's):

| Option                           | Meaning                                                                                                                                |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `--filter <selector>`, `-F`      | pnpm's selectors as ADR 0049 §7 reads them; repeatable                                                                                 |
| `-r`, `--recursive`              | every member, root left out                                                                                                            |
| `-w <name\|dir>`, `--workspace`  | npm's: a name, a directory, or the directory above a level of members; repeatable                                                      |
| `--workspaces`, `-ws`            | npm's: every member                                                                                                                    |
| `--workspace-root`               | the root alone                                                                                                                         |
| `--include-workspace-root`       | keep the root in what `-r`, `--filter` or `--workspaces` select                                                                        |
| `--workspace-concurrency <n>`    | members at once: default `min(4, processors)` for the pnpm style and 1 for the npm style; `0` is every processor, `-n` that many fewer |
| `--parallel`                     | every member at once, no order, streamed                                                                                               |
| `--no-sort`, `--reverse`         | directory order; dependents first                                                                                                      |
| `--stream`, `--aggregate-output` | `--stream` writes each line as it arrives; `--aggregate-output`, the default for members run at once, a block per member               |
| `--if-present`                   | as in ADR 0047, for every member                                                                                                       |
| `-C`, `--dir`, `--prefix`        | other spellings of `--path`                                                                                                            |
| `--silent`, `-s`                 | accepted and ignored: `opm` prints no banner                                                                                           |

`-w` is the one word the tools disagree on: npm's takes a name, pnpm's means the
root. `opm` reads npm's. `pnpm -w run x` is refused before the command with the
spelling to use (`--workspace-root`), and `-w` with no name after the command
says the same, rather than guess.

Contradictions are usage errors (exit 2), not silent choices: `--filter` with
`-w`, `-r` with `--workspaces` (one orders by dependency, the other by
declaration), `--parallel` with `--workspace-concurrency` or an order flag, and
any of `--parallel`, `--stream`, `--no-sort`, `--reverse`,
`--workspace-concurrency` or `--include-workspace-root` with nothing selected.
pnpm options with no counterpart here (`--no-bail`, `--filter-prod`,
`--resume-from`, `--report-summary`, `--reporter`, `--loglevel`,
`--test-pattern`, `--shell-mode` and `-c` for `exec`, and a few more) are
refused by name with the reason. An unknown option stays a usage error (0047
§5).

### Which members, and in what order

1. The workspace root is the project directory of ADR 0047 (`--path`, else the
   nearest `opm.toml`, else where `opm` was started). Discovery is wave one's:
   it reads the declaration without following a link, and a directory that is
   not a workspace is exit 2 naming the root.
2. `--filter`, `-r` and the others select as ADR 0049 defines them. The root is
   left out of `-r` and `--filter` unless `--include-workspace-root`, as pnpm
   does (checked: pnpm 10.28.0 answers `--filter <the root's name>` with "No
   projects matched"). A selection that matches nothing is exit 4; a selector
   `opm` cannot read, or `[since]`, is exit 2. A `./dir` selector is relative to
   the directory `opm` was started in (the root when `--path` names it).
3. **The pnpm style orders by dependency; the npm style does not.** `-r` and
   `--filter` start a member as soon as the selected members it depends on (all
   four dependency lists, direct edges among the selected ones, as pnpm sorts)
   have ended, never more than the limit at once, rather than waiting for a
   whole layer of the order to end first. `--reverse` inverts the edges,
   `--no-sort` and `--parallel` drop them. `-w` and `--workspaces` run in
   directory order, one at a time, because npm orders nothing. The members of a
   dependency cycle run together and one `opm: warning:` line names each cycle
   (pnpm's default; a cycle closed only by `devDependencies` is marked).
4. A member without the script is skipped. When none of the selected members has
   it the run is exit 4 naming how many were looked at, unless `--if-present`.
   (pnpm exits 0 there with a message; a CI step that checks nothing is the
   worse failure.)
5. **With one member to run, it runs exactly as `opm run` runs the project**:
   `opm`'s own streams, its stdin, no prefix. `--filter` on a lone package is
   `--path` with a selector.

### What a member sees

6. Its directory is the working directory (for `exec` too: the member's
   directory, not where `opm` was started). `PATH` leads with the member's own
   `node_modules/.bin`, then each parent's up to the filesystem root, then the
   inherited `PATH`: ADR 0047 §11's rule, applied to the member, so the
   workspace root's `.bin` is on it. The four names are the member's:
   `npm_lifecycle_event`, `npm_package_name`, `npm_package_version`; `INIT_CWD`
   is still where the first `opm` was started. `pre<name>` and `post<name>` run
   around the member's script in npm's order, and a failing hook ends that
   member. Arguments after `--` go to the script of every member, and to no
   hook. Nothing prints the environment.
7. Stdin is not shared: with several members to run each gets none
   (`/dev/null`), because no terminal belongs to many programs. Their output
   goes to pipes, not a terminal, so a tool that colours or animates only on a
   terminal does not.

### What is printed

8. With several members to run every line of a member's output is prefixed
   `<member> <step>: ` (`@s/a build: ...`; `@s/a prebuild: ...` for a hook;
   `<bin>` for `exec`), stdout to stdout and stderr to stderr. The member is its
   name, its directory when it has none, `.` for the root. (pnpm prefixes with
   the directory; the name is what a person filters by.) No header or `Done`
   line is printed: 0047 §14 stands.
9. **Grouped is the default** when members run at once: a member's lines are
   held and written as one block when it ends, so blocks never interleave and a
   log reads member by member. `--stream`, `--parallel`, and a limit of one
   (where nothing can interleave) write each line as it arrives. A member that
   holds more than 8 MiB is written out and streams from then on: memory is
   bounded, and the block promise is given up only for output no one reads as a
   block.

### Failure, signals

10. **The first member to fail ends the run.** Nothing new starts, the members
    still running are sent `SIGTERM` by the rules of ADR 0047 §16 (to the whole
    process group when there is no terminal, to the child alone when there is
    one), `opm` waits for them to end, and the exit status is that member's,
    unchanged: a script that exits 7 makes `opm` exit 7. One line names it:
    `opm: script "build" of @s/b exited with code 3`. The statuses of the
    members it stopped are not considered. A member that cannot be started is
    exit 8 and ends the run the same way.
11. **Signals reach every running member through one subscription.** `SIGINT`,
    `SIGTERM` and `SIGHUP` sent to `opm` are forwarded to each running child by
    the same rules, nothing more starts, and the status is 128 plus the signal
    unless a member failed first. One subscription, not one per child: a run of
    a hundred members does not add a hundred listeners and trip Node's warning.
    A child that ignores `SIGTERM` is waited for, as with `opm run`.

### Spelling

12. The process entry reads the options pnpm and npm put before a command and
    moves them behind it: `opm --filter a run build`, `opm -r exec tsc -b`,
    `opm -C dir run x`, `opm --workspace=a run b`. It does this before it loads
    anything. `--path` and `--if-present` stay after the command (0047), and any
    of `opm`'s own options that still arrive before it are refused ("Put -r
    after the command name") instead of dropped: left in the parser's `head`
    they would be ignored, and `opm -r --offline run build` would run the root's
    script alone.
13. **A word where a command goes is the project's script, else its
    executable.** `opm typecheck`, `opm --filter a build`,
    `opm test:file a.test.ts`, `opm biome check`. Everything after the word goes
    to it (one `--` right after it is dropped, as pnpm does). Only a word that
    is no command qualifies, and outside a pnpm-style option the word must name
    a script or a `.bin` entry here, so a mistyped command is still "Unknown
    command" and a script can never take a command's place (`opm list` is the
    command; `opm run list` is the script). With members selected only scripts
    are tried, as in pnpm 10.28.0 (checked: `pnpm --filter a hellobin` answers
    "None of the selected packages has a script"); `opm --filter a exec <bin>`
    starts a bin.
14. `dlx`, `npx`, `pnpx`, `x` and `create` are not commands. The unknown-command
    message points to `opm exec <bin>` for an installed executable and
    `opmx <package>` for a fetched one: `npx` runs a local bin first and fetches
    otherwise, and `opm` keeps those two apart (0047 §6).

### `exec node`

15. `opm exec node` with no `node` in any `.bin` starts the Node that is running
    `opm`. This is the one name `exec` answers without a `.bin` entry. It is not
    a `PATH` search: the program is `opm`'s own runtime, which no environment
    variable can substitute, and `exec` adds no authority a script lacks (a
    script that says `node` runs whatever `PATH` says), the argument 0047 §7
    makes. A `node` in `.bin` still wins. The test that used `node` as its
    example of "a program on `PATH` is not found" uses `sh`.

### Security

16. Unchanged from 0047, and checked per member: member scripts run unsandboxed
    with the person's authority; a dependency's lifecycle scripts are never run;
    nothing is fetched, installed or resolved; the environment is never printed
    (the tests run a refusal, a failing member and a missing script with a dummy
    token in the environment and read all output for it).
17. **No link is followed to find or read a member.** Discovery refuses a
    symbolic link a pattern selects or goes through by name, and passes over one
    a `**` meets (ADR 0049 §10). The scripts are then read by path (discovery
    does not keep them), so each member's path is checked again: a member
    directory, a directory above it or a `package.json` that is a symbolic link
    is refused with its path, the file is opened without following a link, and
    the real path of the directory is compared once the file is read. Tests put
    a link where a pattern selects it, where a `**` passes it, above the members
    and as `--filter`'s target, and check the script behind it never runs. What
    remains is the window between the check and the read: a path swapped for a
    link in it is followed. Closing it needs the handle-relative walk discovery
    uses, and whoever can win that race can also edit the script they would be
    making `opm` read.
18. The library behind this (workspace discovery, the graph, ordering, the
    scheduler) is loaded only when a selection option, a pnpm-style prefix or a
    script word asks for it. A plain `opm run build` loads none of it; a test
    reads the entry's import graph and fails if that changes.

## Consequences

Measured on this machine (4 shared CPUs, Node 22, linux-x64):

| What                                                                        |              Result |
| --------------------------------------------------------------------------- | ------------------: |
| `node -e 0`                                                                 |               29 ms |
| `opm run ver` through `main.js`, before / after this change (mean of 20)    |     104 ms / 107 ms |
| `opm ver` (a script word; the project is read to know it is one)            |              115 ms |
| `opm run ver -r`, the library loaded and a refusal printed                  |              587 ms |
| HoBo, 791 members, planned (discovery, selection, order), cold / warm       | 859 ms / 450-640 ms |
| HoBo, 791 `package.json` read for their scripts                             |              149 ms |
| HoBo's member list with a trivial script, `opm run build -r`, concurrency 4 |               5.1 s |
| Peak resident set planning HoBo (47 MiB for an idle Node)                   |             114 MiB |

The extra 480 ms of the workspace path is loading the project library; it is
paid only by a run that selects members. The 791 trivial scripts take 6.4 ms
each, a shell and `opm`'s own bookkeeping.

Limits, stated so nobody finds them by surprise:

- `-r` and `--filter` order by direct dependency edges among the selected
  members, as pnpm sorts. A member that depends on another only through a member
  that is not selected does not wait for it.
- pnpm passes an option written after the script (`pnpm run build --watch`) to
  the script. `opm run` still refuses it (0047 §5); write `-- --watch`. After a
  script word (`opm build --watch`) everything goes to the script, as in pnpm.
- `opm exec` across members resolves the bin in every member before starting
  any, and refuses the run, exit 4 naming how many members lack it, if one
  cannot find it: nothing is half run.
- `--filter` follows the four dependency lists, `--filter-prod` is refused, and
  `[since]` is refused (ADR 0049).
- The process group is signalled only when there is no terminal; with one, a
  signal other than the terminal's own `SIGINT` reaches the child and not what
  it started (0047). Windows ends the child, not its tree. The Windows quoting
  is unchanged and has still not been run on Windows.
- A member's `package.json` is read by path, not by handle: see §17.
- `opm` does not search upward for a workspace root other than through
  `opm.toml`: from a member's subdirectory with no `opm.toml` above it, name the
  root with `--path`.
- `opm run build` from inside a member directory runs the project root's
  `build`, not the member's: 0047 §1 (the opm project root) is not changed.
  `opm --filter <name> build` or `-C <member> run build` run the member's.
- Nothing here installs a member's dependencies or links members into
  `node_modules`: `opm ci` and the layout writer do that (ADR 0050).

Not changed: `opmx`, the sandbox, the exit-code table, the default projection
level, ADR 0049's model.
