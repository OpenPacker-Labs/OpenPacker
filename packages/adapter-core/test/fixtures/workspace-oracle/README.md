# Workspace oracles

The golden files beside this directory record what the real tools answered, and
the tests replay the workspace model against them. The scripts here are what
produced them, so a file can be refreshed (a newer tool, a larger battery) by
running them, never by editing the JSON.

Nothing here installs anything into a project. pnpm is run as a program in an
empty home over a throwaway tree; npm's libraries are only read. Each script
refuses a tool whose version is not the one named below (`PINNED` in
`tools.mjs`), because a different version is a different oracle.

| Golden file                    | Script (inputs)                            | The tool                                                                                                                            | Replayed by                                                                                              |
| ------------------------------ | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `workspace-glob-oracle.json`   | `oracle-glob.mjs` (`glob-battery.mjs`)     | pnpm 10.28.0 (`pnpm ls -r`, so its bundled tinyglobby 0.2.14); npm 10.9.4 (`@npmcli/map-workspaces` 4.0.2, glob 10.4.5)             | `workspace-patterns.test.ts`, and `workspace-real-shapes.test.ts` in `opm-project` over real directories |
| `workspace-filter-oracle.json` | `oracle-filter.mjs` (`filter-battery.mjs`) | pnpm 10.28.0 (`pnpm --filter=... ls`), with and without `legacy-dir-filtering`                                                      | `workspace-filter.oracle.test.ts`                                                                        |
| `workspace-range-oracle.json`  | `oracle-ranges.mjs`                        | semver 7.7.2, the copy inside npm 10.9.4 (`satisfies(version, range, true)`)                                                        | `workspace-ranges.oracle.test.ts`                                                                        |
| `npm-range-oracle.json`        | `oracle-npm-ranges.mjs`                    | semver 7.7.2, the version pnpm 10.28.0's own code embeds (npm 10.9.4's copy; `new Range(range).range`, `satisfies(version, range)`) | `npm-ranges.oracle.test.ts`                                                                              |

`workspace-glob-known-differences.json` is not generated: it names the pattern
lists on which pnpm's globber is the odd one out and the model deliberately is
not (see ADR 0049), so the replaying tests can pin that choice instead of
failing on it.

## Regenerating

You need the two tools unpacked somewhere. Let the package manager fetch pnpm
into a scratch project, and use the npm that ships with Node 22:

```sh
SCRATCH=$(mktemp -d) && cd "$SCRATCH"
opm init --name oracle-pnpm
opm add pnpm@10.28.0 --ecosystem npm
PNPM_DIR="$(node -e "console.log(JSON.parse(require('fs').readFileSync('.opm/links/pnpm', 'utf8')).storePath)")/package"
NPM_DIR="$(dirname "$(command -v node)")/../lib/node_modules/npm"   # must be 10.9.4
```

(`opm add npm@10.9.4` does not work yet: the closure of npm holds `npm:` alias
specifiers, and the resolver stops at
`@isaacs/cliui@8.0.2 depends on string-width-cjs as "npm:string-width@^4.2.0"`.)

Then, from the repository root:

```sh
G=packages/adapter-core/test/fixtures/workspace-oracle/generate.mjs
node "$G" all --pnpm "$PNPM_DIR" --npm "$NPM_DIR" --check   # regenerate, compare, change nothing
node "$G" glob --pnpm "$PNPM_DIR" --npm "$NPM_DIR" --write   # replace one file
npx prettier --write packages/adapter-core/test/fixtures/workspace-*-oracle.json
```

`--check` exits 1 and says which file differs; the comparison is of the parsed
JSON, so formatting does not matter. Run time is dominated by starting pnpm for
every case: about a minute for `glob` (115 pattern lists), about four minutes
for `filter` (460 selector lists), instant for `ranges`.

A new case is a new line in the oracle's battery file, then `--write` for that
oracle; the replaying test picks it up with no edit, and a case on which the
model should differ from the tool is a decision to record in the test and the
ADR, not a reason to drop the case.
