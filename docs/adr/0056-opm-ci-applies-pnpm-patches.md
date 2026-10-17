# ADR 0056: `opm ci` applies a pnpm lock's patches

- Status: Accepted
- Date: 2026-10-17
- Amends [ADR 0055](0055-opm-ci-installs-a-pnpm-lock.md) §18.1 and §20: a lock
  with `patchedDependencies` was refused whole; it is installed, patched.
- Relates: [0030](0030-build-versus-buy-for-primitives.md) (the patch applier is
  a port, with pnpm's own code as its oracle),
  [0048](0048-one-copy-per-machine-and-a-node_modules-node-can-resolve.md) §8
  (the shared store and `opm gc --shared`), [0052](0052-pnpm-lockfile-model.md)
  (the lock reader, which already read the section and the `(patch_hash=...)` of
  a snapshot key)

## Context

OpenSesame's lock has four `patchedDependencies` (`braces@3.0.3`,
`js-yaml@3.15.2`, `node-forge@1.4.0`, `@simple-git/argv-parser@2.0.1`), and
`opm ci` refused it by name (ADR 0055 §20, exit 3). A pnpm repository that
patches a dependency could not be installed with opm at all. This makes it
install, with the patch applied exactly as pnpm applies it, and refuses what
pnpm would refuse and what opm will not follow.

Everything below was read in pnpm's own code: the 10.28.0 bundle
(`dist/pnpm.cjs`) and the 9.15.0 one, cited by the source path each module has
inside the bundle.

## Decision

### What is read

1. **The lock records** `patchedDependencies: { <key>: { hash, path } }`, with
   `lockfileVersion: '9.0'` from both pnpm 9 and pnpm 10 (`LOCKFILE_VERSION` is
   `9.0` in both bundles), and each patched snapshot's key carries
   `(patch_hash=<hash>)` before any peer suffix. ADR 0052's reader already read
   both; nothing in the lock's shape changes between the two versions. What
   changes is the hash (point 4).
2. **The project declares** them in the root `package.json`
   (`pnpm.patchedDependencies`) or in `pnpm-workspace.yaml`
   (`patchedDependencies`). When `package.json` has the key at all its map is
   taken whole and the workspace file's is not read, because pnpm spreads
   `getOptionsFromRootManifest` over the workspace settings at install (as for
   `overrides`, ADR 0055 §18.4). A path is joined to the directory of the file
   that named it (the root, for both) unless absolute
   (`getOptionsFromPnpmSettings`, `../config/config/lib`).
3. **Which patch a package takes** is pnpm 10.28's rule
   (`groupPatchedDependencies` and `getPatchInfo`, `../patching/config/lib`):
   the key `name@1.2.3` for that exact version, else the one `name@<range>` the
   version satisfies (two are `ERR_PNPM_PATCH_KEY_CONFLICT`), else `name@*` or a
   bare `name`. A key whose version part is neither a version nor a range is
   `ERR_PNPM_PATCH_NON_SEMVER_RANGE`. pnpm 9.15 knew only the exact and the bare
   forms, which mean the same here. pnpm decides by name and version, so a patch
   applies to every instance of `name@version` in the lock, whatever its peers:
   there is no "patched here, unpatched there" in one lock.

### The hash

4. **The hash is of the patch file read as UTF-8 text with every `\r\n` made
   `\n`**, so a checkout with either line ending has one hash
   (`readNormalizedFile`). pnpm 10 records its sha256 in hex, 64 characters
   (`calcPatchHashes`, `../lockfile/settings-checker/lib`, through
   `createHexHashFromFile`, `../crypto/hash/lib`). pnpm 9 recorded its md5 in
   RFC 4648 base32, lower case, without padding, 26 characters
   (`createBase32HashFromFile`, `../packages/crypto.base32-hash/lib` in 9.15.0).
   OpenSesame's lock has pnpm 9's.
5. **The lock must record what the project's files give now**, as
   `pnpm install --frozen-lockfile` requires (`getOutdatedLockfileSetting`,
   `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`): the same keys, each `path` the
   project's path made relative to the lock, each `hash` the file's. opm
   computes the hash in the form the lock's has: a pnpm 9 hash with pnpm 9's
   algorithm. **This is deliberately not pnpm 10's rule.** pnpm 10.28 compares
   only its own sha256, so it calls every lock pnpm 9 wrote with a patch stale
   (its bundle has no base32 at all; `getOutdatedLockfileSetting` returns
   `patchedDependencies` for a 26-character hash, checked by running the
   bundle's function). pnpm 9, which wrote the lock, accepts it, and so does
   opm. A hash of neither form is refused.
6. **The snapshots must agree with the section:** an instance a patch applies to
   must carry that patch's hash as its `(patch_hash=...)`, one that carries a
   hash must have a patch that applies, and every key must apply to some package
   of the lock (pnpm refuses an unused patch when it resolves,
   `ERR_PNPM_UNUSED_PATCH`, `verifyPatches`; its frozen install does not ask). A
   package the install leaves out (`--filter`, another platform) is not patched,
   and its key is not refused for that.

### How a patch is applied

7. **pnpm applies a patch with its fork of patch-package**,
   `@pnpm/patch-package` 0.0.1, from `applyPatchToDir`
   (`../patching/apply-patch/lib`), which `buildDependency`
   (`../exec/build-modules/lib`) calls for each patched package. opm's applier
   (`packages/adapter-npm/src/pnpm-patch/`) is a port of it, step for step:
   `parse.js` (the header and hunk states, a blank or `\r` line read as context,
   the `\ No newline at end of file` pragma, the hunk-length check, and the
   second reading as a legacy diff without `diff --git` lines), `apply.js`
   (`executeEffects`, `applyPatch`, `evaluateHunk`), `reverse.js`, and
   `applyPatch` of `applyPatches.js`. So:
   - a hunk is placed at its header's line, then 1 up, 1 down, 2 up, ... as far
     as 20 either way; 21 fails the file;
   - a line matches when the two are equal after trailing whitespace is trimmed,
     so a `\r` in the file or the patch, or a trailing space, does not stop a
     hunk; inserted lines are written as the patch has them, and the file is
     split and joined at `\n` only (so a CRLF file patched by an LF patch has
     mixed endings, as with pnpm);
   - a new file (`new file mode 100644` or `100755`) replaces a file already at
     its path, a deleted file's text is not compared, a rename never overwrites,
     a mode change sets 644 or 755; any other mode (a symlink's `120000`) makes
     the patch unreadable, `ERR_PNPM_INVALID_PATCH`;
   - a binary diff is read as nothing, as pnpm reads it;
   - when the patch fails, it counts as applied if its reverse would apply: the
     package already has the change;
   - a patch that fails otherwise is `ERR_PNPM_PATCH_FAILED`.
8. **Why a port and not the package** (ADR 0030, outcome 2): the package changes
   the process's working directory to the package (`process.chdir`), writes
   wherever a path in the patch points, `../../x` included, leaves a package
   half patched when a later file fails, and brings fs-extra, chalk, klaw-sync
   and semver. opm's contract is narrower, and the package is the oracle
   instead: `packages/adapter-npm/test/pnpm-patch-oracle/generate.mjs` loads
   `applyPatchToDir` and `calcPatchHashes` from the 10.28.0 and 9.15.0 bundles
   without running pnpm's command line and records what they do with 37 patches
   and 7 patch files; the port must give the same outcome and the same files
   (content and executable bit) for each, or the same hash. Mutating the fuzz
   bound and the whitespace rule failed four cases.
9. **opm applies a patch whole or not at all.** The paths it names, and every
   directory above them, are read into memory, the patch runs there with the
   rules above, and the files are written only when it applied. Where pnpm fails
   it leaves what it did up to the failure; opm leaves the package as it was,
   and the install stops.

### Where the patched package lives

10. **A patched package is a store entry of its own**:
    `sha256-<archive digest>-patch-<sha256 of the patch file's bytes>`. The
    second hash is of the bytes as read, which are the bytes applied, and not
    the lock's hash, which pnpm takes of the text with CRLF made LF (point 4).
    An LF and a CRLF checkout of one patch have one lock hash and are two
    entries: the CRLF one inserts lines that end in `\r` (pnpm reads the file
    with `readFileSync(...).toString()` and applies it as it is), so a key named
    by the lock's hash would hold whichever tree was published first, and a
    project's install would depend on another project's checkout. pnpm does the
    same in its own way: the patched files are in a virtual-store directory
    whose name carries the hash (`depPathToFilename`,
    `name@1.0.0_patch_hash=...`), apart from the store's unpatched files, and
    its side-effects cache key carries `patchFileHash` (`calcDepState` in
    `buildDependency`); pnpm's directory is per project and is not checked
    against a recorded tree, so its normalized name does it no harm. A project
    that installs a package unpatched never links a patched file, one that
    patches it never links an unpatched one, and two patch files whose bytes
    differ never share an entry.
11. **The entry is made as an archive's is** (`frozen-patch.ts`): the unpatched
    entry is copied (its files are every project's and are never written) into
    `.<key>.materialize-<uuid>` beside it, patched there by the format
    (`ProjectFormat.applyFrozenPatch`), hashed, sealed read-only, and renamed
    into place. **Only the install whose rename won writes `<key>.tree`**, and
    after the rename: two installs that make the same entry at once never leave
    a record of the tree that lost (an archive's record is written before its
    rename, which is safe there because every publisher of a key extracts the
    same tree; a patched tree is the output of opm's applier, and the record
    follows the rename so that agreement does not rest on the applier alone). An
    entry already there is adopted only after its tree is hashed again against
    that record; one renamed into place whose record is not there yet is waited
    for, up to ten seconds, and is then the error an unrecorded entry always
    was. `opm gc --shared` reads the key under ADR 0048 §8's rules: kept while a
    project links any of its files, kept while its `.tree`, or the directory
    itself while it has no record, is younger than the age rule, removed with
    its record otherwise, and a leftover `.<key>.materialize-` cleared once old.
12. **Order.** The archive is fetched, proved against the lock's integrity,
    extracted, and proved to be the package the lock names (ADR 0055 §7)
    **before** it is patched: a patch that edits `package.json` changes what is
    installed, not what was checked. Whether a package declares an install
    script is then read from what is installed, the patched files (a patch that
    adds a `postinstall` is reported).

### What is refused, by name, before anything is fetched

13. In the order of ADR 0055 §18:
    - by the lock alone (exit 3): a key that applies to no package of the lock;
      two ranges one version satisfies; a key that is neither version nor range;
      a snapshot that does not carry the hash of its patch, or carries one no
      patch gives; a hash of neither pnpm's form;
    - by the project's files: a patch file that is not there (`NOT_FOUND`, exit
      4, as pnpm's `ENOENT`); a path that leaves the project through `..` or an
      absolute path, or that is reached through a link (`UNSAFE_PATH`, exit 7);
      a patch that names a path outside its package or with an empty, `.` or
      `..` segment, a backslash or NUL, or one past the bounds of a path in an
      archive, 128 segments or 4,096 UTF-8 bytes (`UNSAFE_PATH`); a patch that
      names more than the 100,000 files an archive may hold (`SIZE_LIMIT`, exit
      7); the three bounds are `PACKAGE_TREE_LIMITS`, the ones `opm ci` extracts
      an archive under, so no path of a patched entry is one an archive could
      not hold; a patch pnpm cannot read (`INVALID_PATCH`, exit 3); and, as a
      stale lock (exit 3, "pnpm install --frozen-lockfile would refuse too"), a
      key added or removed, a path moved, a file edited;
    - when it is applied (exit 3): a patch that does not apply (`PATCH_FAILED`).
14. **What pnpm does that opm refuses, and why:**
    - a path in the patch that leaves the package, or a link in the package on
      the way to a path it names: pnpm follows both and writes outside the
      package; opm writes only below it;
    - a path past an archive's bounds: pnpm makes the directories whatever their
      depth (a 12 KB patch names a path 2,000 deep), and opm refuses it as it
      refuses that path in an archive;
    - a patch that fails for a bare-name key, or with `ignorePatchFailures`:
      pnpm warns and installs the package unpatched; opm refuses, because a lock
      that says a package is patched and an install where it is not are two
      different programs;
    - a rename or mode change of a directory: pnpm would move or chmod it; a git
      diff never makes one, and opm changes files only;
    - a pnpm 10 install of a lock pnpm 9 wrote with patches is refused by pnpm
      10 as stale; opm installs it (point 5);
    - a key that applies to no package: pnpm's frozen install does not check it;
      opm refuses it, as pnpm's resolving install does (`allowUnusedPatches` is
      not read).

## Consequences

Measured on 2026-10-17, linux-x64, Node 22.22.0, on a 4-CPU VM under a load
average of 17 to 37 from other work, against registry.npmjs.org through the
sandbox proxy, with a fresh store on tmpfs (the disk had 1.6 GB free).
OpenSesame was copied with `git archive origin/main` (b788faadc) for its 81
`package.json` files, `pnpm-workspace.yaml`, `pnpm-lock.yaml` and `patches/`.

| Measured                                                                     | Result                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `opm ci --plan`, the whole lock                                              | exit 0 (was exit 3): 1,758 packages in 2,847 places from 1,739 archives, 4 packages patched by 4 patches, 71 of 71 members; the four pnpm 9 hashes match their files                                                                                                                                     |
| `opm ci`, the whole lock                                                     | exit 7 after 244 s, not for a patch: `sylvester@0.0.21`'s archive is a gzip stream padded with zero bytes to 30,720, which the materializer's `DecompressionStream` refuses ("Trailing junk found after the end of the compressed stream") and Node's zlib, and so npm and pnpm, accepts. Not fixed here |
| `opm ci --filter '!./tests/redteam'` (the one member that needs `sylvester`) | exit 0 in 219 s: 2,054 places of 1,305 packages, 377 archives fetched (78.4 MB) and 911 from the store, 3 packages patched by 3 patches, 47 of 71 members linked                                                                                                                                         |
| each patched package against GNU `patch -p1` 2.7.6                           | `braces@3.0.3` (4 of 10 files changed), `js-yaml@3.15.2` (1 of 36), `node-forge@1.4.0` (1 of 59): the installed directory equals the unpatched entry patched by GNU patch, file for file and executable bit for executable bit; Node resolves `braces` to the patched copy                               |
| `@simple-git/argv-parser@2.0.1`, not installed above                         | its archive from the registry, checked against the lock's sha512, patched by opm's applier and by GNU patch: the 42 files are the same, and its pnpm 9 hash is the lock's `wbmb7dwhiv66et2i6bbymnlkhi`                                                                                                   |

Costs and limits:

- **Two copies of a patched package's files** on the machine: the unpatched
  entry and the patched one. A patched package is small next to a closure, and
  linking the patched entry to the unpatched one's files would make each keep
  the other alive in `opm gc --shared`'s eyes.
- **The applier is a second implementation of pnpm's.** The oracle is what keeps
  it pnpm's; a new pnpm that changes `@pnpm/patch-package` needs the generator
  run again against it, and a change to what the applier writes must change the
  store key's form (`-patch-` is the first).
- **Scripts are still not run** (ADR 0055 §21), patched or not.
- **The gzip padding of old archives** (above) blocks OpenSesame's
  `tests/redteam` until the materializer accepts what Node's zlib accepts after
  the end of a gzip stream; that is the materializer's change to make, with its
  own review.
