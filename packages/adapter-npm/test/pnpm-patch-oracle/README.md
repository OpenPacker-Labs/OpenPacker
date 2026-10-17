# pnpm's own code, as the oracle of the patch applier

ADR 0056: `opm ci` applies a pnpm lock's `patchedDependencies` with a port of
the code pnpm 10.28 applies them with (`src/pnpm-patch/`). `oracle.json` is what
pnpm's own code does with every case of `cases.mjs`, and
`src/pnpm-patch/oracle.test.ts` holds the port to it.

```sh
node generate.mjs <pnpm 10.28.0 package dir> <pnpm 9.15.0 package dir>          # write oracle.json
node generate.mjs <pnpm 10.28.0 package dir> <pnpm 9.15.0 package dir> --check  # compare, exit 1 on a difference
node_modules/.bin/prettier --write oracle.json  # from the repository root: its format
```

The directories are the `pnpm` packages themselves (`package.json` and
`dist/pnpm.cjs`), and a different version is refused. Nothing is installed and
pnpm's command line is not run: `generate.mjs` reads `dist/pnpm.cjs`, cuts it
before the code that starts the command line, and takes the modules it needs by
their source path inside the bundle:

| Module in the bundle                                  | From            | What it records                                                                                                                                               |
| ----------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `../patching/apply-patch/lib/index.js`                | 10.28.0         | `applyPatchToDir` over a package in a temporary directory: the outcome (`applied`, `ERR_PNPM_PATCH_FAILED`, `ERR_PNPM_INVALID_PATCH`) and every file after it |
| `../lockfile/settings-checker/lib/calcPatchHashes.js` | 10.28.0, 9.15.0 | the `{ hash, path }` each writes into a lock for a patch file                                                                                                 |

`applyPatchToDir` is the function pnpm calls for each patched package, and it
runs `@pnpm/patch-package` 0.0.1 and fs-extra 11.3.2 as bundled, so the case
outcomes are pnpm's, not a reading of its source. The cases (`cases-hunks.mjs`,
`cases-files.mjs`, `cases.mjs`) cover a hunk at its line and up to 20 lines from
it (21 fails), line endings both ways, trailing whitespace, a missing final
newline, files added, deleted and renamed, a mode change, a patch the package
already has, a second file that fails, a legacy diff with no `diff --git` lines,
a binary diff, and the patches pnpm cannot read. Where pnpm fails, the test also
requires that opm left the package as it was (pnpm leaves what it did up to the
failure).

What the oracle cannot show is in `src/pnpm-patch/refuse.test.ts`: the paths opm
refuses that pnpm follows (`../`, an absolute path, a link in the package). pnpm
writes there, and a generator should not.

Generated on 2026-10-17 with pnpm 10.28.0 (`/opt/node-tools/node_modules/pnpm`)
and pnpm 9.15.0 (the copy corepack keeps under `~/.local/share/pnpm/.tools`).
