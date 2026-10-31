# ADR 0061: `npm run` inside `opm run` runs `opm run`

- Status: Accepted
- Date: 2026-10-31
- Amends [ADR 0047](0047-opm-run-and-exec-run-the-users-own-scripts.md) §11 (the
  environment: the shims lead `PATH`, and two more names are set)
- Relates: [ADR 0053](0053-opm-run-across-workspace-members.md) (the member
  options the shims pass on)

## Context

Scripts call each other: `"test": "npm run lint && npm run unit"`. Under
`opm run` the inner `npm run` went to whatever npm was on `PATH`: npm read the
project by its own rules, printed its banner, set its own environment, and
answered every other npm command too (`npm install` in a script installed with
npm). With no npm on `PATH` it was `npm: not found`. The projects this serves
use OpenPacker instead of npm or pnpm directly, so a chained run should be
opm's, and a script that asks npm for anything else should be told what to use,
not reach npm.

## Decision

1. **Shims.** The opm package ships `shims/bin/npm`, `shims/bin/pnpm` and
   `shims/bin/yarn` (POSIX `sh`), with a `.cmd` beside each, next to `dist`
   (`files` lists `shims`). Each starts `dist/shims/<tool>.js` with the Node
   that `npm_node_execpath` names, `node` when it is unset. The POSIX script
   finds its own directory with `${0%/*}`, so it needs no program on `PATH`.
   They are files of opm's installation, outside the project, and nothing writes
   them at run time.
2. **On `PATH`, first.** `opm run` and `opm exec` put the shims' directory first
   on the child's `PATH`, before the `.bin` directories, so a project bin named
   `npm` does not answer instead. A nested run puts it first again and drops the
   copy an outer run put there; the rest of the inherited `PATH` is left as
   written.
3. **Two names more.** `npm_execpath` is `dist/shims/npm.js` and
   `npm_node_execpath` is the Node that runs opm. npm sets both to its own
   script and Node, and tools that start the package manager again read them:
   npm-run-all's `run-s` and `run-p` start `node "$npm_execpath" run <x>` when
   it is a `.js` file. The run a shim makes is `opm run`, so it sets what
   `opm run` sets: `npm_lifecycle_event`, `npm_package_name`,
   `npm_package_version`, and `INIT_CWD` kept from the outer run.
   `npm_config_user_agent` is neither set nor removed, as before: `opm run` did
   not set it, and a tool that reads it to choose npm, pnpm or yarn reaches a
   shim whichever it chooses. npm's `npm_command`, `npm_lifecycle_script`,
   `npm_package_json` and `npm_config_*` are not set, as before.
4. **npm.** `run` (`run-script`, `rum`, `urn`), `test` (`t`, `tst`), `start`,
   `stop` and `restart` run that script through `opm run`, with the arguments
   npm gives it: the words after the script's name and everything after `--`.
   The npm options `opm run` reads are taken anywhere before `--`, before or
   after the command, as npm takes them: `--if-present`, `-w`/`--workspace`,
   `--workspaces`/`-ws`, `--include-workspace-root`, `-s`/`--silent` (opm prints
   no banner) and `--prefix`/`-C` (the project). Any other option is refused by
   name: npm reads it as its own setting and does not pass it to the script, and
   a dropped `--watch` is worse than a refusal (ADR 0047 §5).
5. **pnpm.** `run`, `test`, `start`, `stop`, `restart`, and `pnpm <word>`: that
   script, else that installed executable, as pnpm does and as `opm <word>`
   does. Everything after the script's name goes to the script verbatim, `--`
   included: measured on pnpm 10.28.0, `pnpm run echo a --b -- c` gives the
   script `a --b -- c`. pnpm's own options come before the name and are opm's
   (ADR 0053): `--filter`/`-F`, `-r`, `--workspace-root` and pnpm's `-w`, which
   is the root (opm's `-w` is npm's), `--include-workspace-root`, `--parallel`,
   `--stream`, `--aggregate-output`, `--no-sort`, `--reverse`,
   `--workspace-concurrency`, `--if-present`, `-s`, and `-C`/`--dir`.
6. **yarn, where its releases agree.** `yarn <word> [words]`,
   `yarn run <script> [words]`, `yarn workspace <name> …`, `-s` and `--cwd`. A
   `--` or an option after the script's name is refused: Yarn 1.22.22 drops a
   `--` with a warning and reads options before it (measured:
   `yarn run echo a --b -- c` gave the script `a c`), later releases pass them
   on, and nothing tells the shim which yarn the script was written for. The
   refusal says to write `opm run <script> -- <args>`.
7. **The package the tool would use.** The run is in the nearest directory at or
   above the working directory that has a `package.json`, which is how npm, pnpm
   and yarn each find it (`cd sub && npm run x` runs `sub`'s `x`), and with
   member options in the nearest workspace root above that
   (`pnpm-workspace.yaml` or a `package.json` with `workspaces`). `--prefix`,
   `-C`, `--dir` and `--cwd` name it instead. opm's own rule, the nearest
   `opm.toml`, would run the project's script for a script that changed
   directory.
8. **Everything else is refused, never handed on.** Every other command of the
   three tools, and the tool with no command, exits 2 with
   `opm: <tool> <command> inside opm run: opm runs … itself and hands nothing to <tool>; …`
   and what to run: `install` and `ci` → `opm ci` or `opm add <spec>`,
   `uninstall` → `opm remove`, `update` → `opm update`, `exec` →
   `opm exec <bin>` or `opmx <package>`, `dlx` and `create` → `opmx`, `ls` →
   `opm list`, `why` → `opm why`, `view` → `opm info`, `publish` →
   `opm publish`, `pack` → `opm pack npm`, `init` → `opm init`,
   `yarn workspaces` → `opm run --workspaces` or `-r`, and otherwise that opm
   has no counterpart and the command belongs outside `opm run`. A shim never
   starts npm, pnpm or yarn. A missing script exits 4, as under `opm run`.
9. **Windows.** `npm.cmd`, `pnpm.cmd` and `yarn.cmd` start the same scripts
   (`"%~dp0..\..\dist\shims\<tool>.js" %*`, CRLF kept by `.gitattributes`). The
   variable keeps its spelling (`Path`) and `;`. When `opm run` decides whether
   a script's first word is a batch file (ADR 0047 §18) it looks in the shims'
   directory first, so the arguments of `npm run x -- a` are escaped for a batch
   file. Checked by text and value here, not run on Windows.

## Consequences

- A chained run is opm's whether or not npm is installed. On this machine (load
  average about 30), `opm run b` took 180 ms, `opm run a` with `a` = `npm run b`
  490 ms, and `npm run a` with the same chain under npm 883 ms (mean of 10).
- What a script asks of npm that opm does not do now fails where it ran before:
  that is the point, and the message names the opm command.
- npm's fallbacks for a missing script are not reproduced: `npm start` with no
  `start` script runs `node server.js`, and `npm restart` with no `restart` runs
  `stop` and `start`. Under the shim opm says the script is missing (exit 4).
- `npx` and `pnpx` are not shimmed: a script that calls them still reaches the
  npm on `PATH`.
- A script under `opm run` runs with the person's authority (ADR 0047 §6) and
  can write what they can, the shims included. opm makes no copy per run for a
  script to redirect; the shims are part of the installation.
- Tests: apps/opm `run-npm-shim.test.ts` (with no npm, pnpm, yarn or node on
  `PATH`: `npm run b`, `npm test` and its hooks, `npm run x -- --flag` and words
  after the name, `--if-present`, a missing script, the nearest `package.json`,
  a project bin named `npm`, `npm_execpath` started by Node, `-w` and
  `--workspace`, a refused `npm install`, `npm exec` and `--watch`; pnpm's
  `run`, `<script>`, `--filter` and refusals; yarn's words and refusals; and
  with npm on `PATH`), `run-foreign-args.test.ts` (each tool's grammar, the
  environment on POSIX and Windows, the shims' text and mode) and
  `run-load.test.ts` (the shims load nothing outside Node and opm's directory).
