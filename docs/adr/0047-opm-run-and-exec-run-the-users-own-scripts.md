# ADR 0047: `opm run` and `opm exec` run the user's own scripts

- Status: Accepted
- Date: 2026-10-11
- Relates: [ADR 0033](0033-native-supply-chain-capture-and-mitigation.md) (the
  gates a package passes before it is in `node_modules`),
  [ADR 0034](0034-opm-projects-into-native-project-formats.md) (the `layout`
  level writes `node_modules/.bin`),
  [ADR 0036](0036-sandboxed-installs-and-execution.md) (package execution runs
  in a jail; amended below for these two commands),
  [ADR 0042](0042-upm-v1-gaps.md) (no workspace graph),
  [ADR 0048](0048-one-copy-per-machine-and-a-node_modules-node-can-resolve.md)
  (the `.bin` shims)

## Context

A project's tests, builds and checks run through `vitest`, `tsc`, `tsx` and
`vite`, which live in `node_modules/.bin`, and are started from `package.json`
scripts. One workspace repository calls `pnpm run` 81 times, `exec` 4 times and
`--filter` 8 times. Since ADR 0048 `opm` writes `node_modules` and the `.bin`
shims, but it had no command that starts a script or a bin, so none of that
could be written in terms of `opm`. `opmx` is not it: it fetches or looks up a
package and runs it inside the jail (ADR 0036), which is the right behaviour for
a tool the person has not reviewed and the wrong one for `vitest run` in their
own repository.

## Decision

### Two commands

1. `opm run [<script>] [--if-present] [--path <dir>] [-- <args...>]` reads the
   `scripts` of the `package.json` at the opm project root, the nearest
   directory at or above the working directory that holds an `opm.toml` (the
   working directory itself when there is none). `--path <dir>` names the
   project directory exactly and is not searched upward. With no script it lists
   them, `name<TAB>command` in file order. `--if-present` makes an undefined
   script a success that runs nothing, hooks included.
2. `pre<name>` and `post<name>` run around `<name>` in npm's order. Only those
   that exist run; `<name>` must exist. The first step that exits non-zero ends
   the run with that step's status, and a message on stderr names the step.
   Arguments after `--` are appended to `<name>` and to nothing else.
3. `opm exec <bin> [-- <args...>]` resolves `<bin>` from `node_modules/.bin` of
   the project root and of each ancestor directory, nearest first. It never
   fetches anything and never searches `PATH`: a program that is not in a `.bin`
   directory is not found. `<bin>` is a name, not a path. Everything after the
   bin goes to the bin, with or without `--`, so `opm exec vitest --help` is
   vitest's help; only a flag before the bin name is `opm`'s.
4. A bin that is not found exits 4 and says why, from the lock data `opm why`
   reads: the locked package that declares it (a direct requirement's `bins` are
   recorded in `opm.lock.json`), or one whose own name is the bin's name (npm's
   default bin, the only evidence a dependency's lock entry allows), and what to
   change: set `native_projection = "layout"` and run `opm sync`, or run
   `opm sync` where it is already set. Windows never runs the extensionless
   POSIX shim, so only the extensions in `PATHEXT` (default
   `.COM;.EXE;.BAT;.CMD`) count there.
5. An option `opm` does not know is a usage error, never dropped. A silent
   `--watch` that runs the script without it is the worse failure.

### Authority

6. **These commands run the person's own code with the person's authority,
   unsandboxed, as `npm run` does.** The scripts are in the person's
   `package.json`, written or reviewed by them, and the bins are what their
   scripts already call. They do not go through the jail and `--help` says so.
   This amends ADR 0036 point 4 ("single enforcement funnel") for these two
   commands and only these: `opmx`, installs, host installers and any lifecycle
   script that `opm` runs on a package's behalf stay in the funnel.
7. `exec` adds no authority that `run` does not have: any script can call any
   `.bin` entry, so `opm exec x` is a script of one line. What bounds it is how
   the bin got there: through `add`/`sync`, under the supply-chain gates of ADR
   0033, as a validated shim written without running a package script (ADR
   0043).
8. **A dependency's lifecycle scripts are never run by these commands.** `run`
   starts the scripts of the project's own `package.json` only. A name is looked
   up in that file, never in a dependency's.
9. Nothing is fetched, installed, resolved or written. `run` and `exec` load no
   adapter and no plugin, so a plugin store problem cannot reach a script's
   stderr.
10. **The environment is never printed**: not on success, not on failure, not in
    a spawn error, not in `--help`. Tests run the failure paths and `--help`
    with a dummy token in the environment and check the output for it.

### Environment and streams

11. The child inherits `opm`'s environment. `PATH` is the `.bin` directories of
    the project root and of each ancestor, nearest first (as npm does, including
    those that do not exist), followed by the inherited `PATH`; on Windows the
    variable keeps its existing spelling (`Path`) and the delimiter is `;`. Four
    names are set and nothing else is added, removed or rewritten:
    `npm_lifecycle_event` (the step being run, so `pretest` during the hook;
    `exec` for `exec`), `npm_package_name` and `npm_package_version` (when the
    `package.json` has them) and `INIT_CWD`, the directory `opm` was started in,
    kept if an outer `opm` or npm already set it so a nested call keeps the
    answer to "where was the person".
12. A script runs with the project root as its working directory. A bin runs in
    the directory `opm exec` was started in, or in `--path`'s directory.
13. Stdin, stdout and stderr are the process's own whenever `opm` writes to
    them, so a terminal stays a terminal and nothing is buffered. A caller that
    supplies other streams (a test, an embedding host) gets the child's output
    written to them.
14. No banner is printed. `opm run build | jq` is the child's output and only
    that.

### Exit status and signals

15. The exit status is the child's, exactly: a script that exits 7 makes `opm`
    exit 7. A child ended by a signal gives 128 plus its number, the shell's
    rule. `opm`'s own failures use the existing table:

    | Situation                                                                                                                  | Exit |
    | -------------------------------------------------------------------------------------------------------------------------- | ---: |
    | An unknown flag, no script name before `--`, no bin, a path                                                                |    2 |
    | A `package.json` that is malformed, or a script that is not a string; a Windows batch file whose path holds `%` or a quote |    3 |
    | Script, bin or `package.json` not found                                                                                    |    4 |
    | The process could not be started                                                                                           |    8 |

    A script's own status shares the numeric space with `opm`'s, so a script
    that exits 4 looks like a missing script to a caller that reads only the
    number. Every `opm` failure writes a line starting `opm:` to stderr. A
    missing script is "not found" (4) like a missing alias in `opm why`, and is
    distinct from the generic usage error (2).

16. `SIGINT`, `SIGTERM` and `SIGHUP` sent to `opm` are forwarded. With no
    terminal on stdin, stdout or stderr the child starts in a session and
    process group of its own (Node's `detached`, which is `setsid`, so it also
    has no controlling terminal) and the signal goes to the whole group, so
    `a && b` and everything either started stop with it; this is what a
    supervisor's `kill` or a CI timeout needs. With a terminal the child stays
    in the foreground group the terminal already signals, because a child in a
    group of its own would be stopped the moment it read the terminal. The
    terminal has then already delivered `SIGINT` to the child, and a second one
    is read as "stop now" by tools that treat the second that way, so `SIGINT`
    is left alone and `SIGTERM` and `SIGHUP` go to the child. Measured once by
    hand under a real pseudo-terminal, not by an automated test: one `^C`
    reached the script once (a Python `pty` driver sent the interrupt character;
    the script counted its `SIGINT`s).

### How a command is handed to the system

17. POSIX: a script goes to `/bin/sh -c`, as under `npm run`, not to `$SHELL`.
    Extra arguments are positional parameters (`sh -c '<script> "$@"' sh a b`),
    so the shell never re-reads them: `$(id)`, quotes, `;` and line breaks in an
    argument reach the script verbatim. A bin is executed directly with no
    shell.
18. Windows: Node refuses to start a `.cmd` or `.bat` file without a shell, so a
    script, and a bin that resolves to a batch file, go to
    `cmd.exe /d /s /c "<line>"` with `windowsVerbatimArguments`. An argument is
    quoted for the C runtime (backslashes literal except before a quote, a quote
    becomes `\"`) and every `cmd.exe` metacharacter in it, quotes included, is
    escaped with `^` so `cmd.exe` never sees an operator or enters quote mode. A
    target that is a batch file reads the line a second time through `%*`, so
    its arguments are escaped twice; for a script that is decided from the first
    word of the script, resolved as npm does. A line break or NUL in an argument
    is refused, and so is a batch file whose path contains `%` or a quote, which
    no quoting protects. A real `.exe` is spawned directly with no shell.
    Termination on Windows ends the child, not its tree.

### The process entry

19. `main.js` is the bin of `opm`, `opkg` and `opkgm`. It answers `run` and
    `exec` from modules that import nothing outside Node and their own
    directory, and hands everything else to `opm.js` unchanged. The project
    library and every adapter cost more to load than Node costs to start, and a
    build calls `opm run` dozens of times. A test reads the import graph and
    fails if the fast path acquires a workspace import. Failures use the same
    `handleError`. `dist/opm.js` still works as an entry and still answers `run`
    and `exec`. `opmx-main.js` is the bin of `opmx` and runs it without asking
    whether it is the entry: a package manager starts a bin through a link, and
    `dist/opmx.js` decides by comparing its URL with `process.argv[1]`, which is
    false then and ran nothing, with exit code 0. `dist/opmx.js` still works
    started by its own path. `bins.test.ts` starts every declared bin through a
    link.

## Consequences

Measured on this machine (4 shared CPUs, Node 22, a project with vitest 4.1.9
laid out by `native_projection = "layout"`; mean of 10 runs of `--version`):

| Command                                           | Time per run |
| ------------------------------------------------- | -----------: |
| `node -e 0` (the floor)                           |        99 ms |
| `vitest --version` through its `.bin` shim        |       135 ms |
| `opm exec vitest -- --version` via `main.js`      |       234 ms |
| `opm run ver` via `main.js`                       |       248 ms |
| `opm run ver` via `opm.js` (library loaded first) |       558 ms |

The overhead of `run` over calling the shim is about 110 ms (a shell and `opm`),
down from about 420 ms.

Limits, stated so nobody finds them by surprise:

- There are no workspaces here (ADR 0042): no `--filter`, no `--workspace`, no
  per-member `node_modules`. `opm run` reads one `package.json`.
- `run` does not search upward for a `package.json` as npm does; it uses the opm
  project root or `--path`.
- Only the four names above are set. Tools that detect their package manager
  from `npm_config_user_agent` or `npm_execpath` see none.
- A POSIX host with no `/bin/sh` cannot run a script (exit 8). `exec` needs no
  shell.
- Process-group delivery needs POSIX and no terminal. With a terminal, a signal
  other than the terminal's `SIGINT` reaches the child and not what the child
  started. On Windows the child is ended, not its tree.
- The Windows paths have been verified against the quoting rules in unit tests
  that run on every host. They have not been run on Windows.
- `cmd.exe` limits a command line to 8191 characters.
- Ancestor `.bin` directories are trusted as npm trusts them: an executable in a
  `node_modules/.bin` that someone else can write, in a directory above the
  project (a shared `/tmp`, say), is on `PATH` for `run` and found by `exec`.
  `opm` does not check who owns those directories.

Not changed: `opmx`, the sandbox funnel for everything else, the default
projection level, and the exit-code table.
