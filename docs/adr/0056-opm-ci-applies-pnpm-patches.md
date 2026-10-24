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
   `ERR_PNPM_PATCH_NON_SEMVER_RANGE`. A key is read as `dp.parse`
   (`../packages/dependency-path/lib`) reads it: the version is what follows the
   first `@` after the start, less a run of `(...)` groups at its end (a peer
   suffix or a `(patch_hash=...)`, found by `indexOfDepPathSuffix`'s scan, which
   takes an unbalanced end for no suffix), and it is exact when node-semver's
   strict `valid` takes it: so `x@1.0.0(peer@1.0.0)` is the exact key of
   `1.0.0`, while `1.0.0-01`, a number past 2^53 - 1 and a version longer than
   256 characters are neither a version nor a range. pnpm 9.15 looked a package
   up by the exact string `name@version`, then by `name` (`getPatchInfo` in the
   9.15.0 bundle), and knew no other form. **A lock pnpm 9 wrote is read by
   these 10.28 rules too.** The two agree on the forms pnpm 9 knew; any other
   key (a range, `*`, a `(...)` suffix) pnpm 9 never matched, and so did not
   patch, while opm reads it by the 10.28 rule: a snapshot it applies to carries
   no `(patch_hash=...)` in such a lock, and opm refuses the lock rather than
   install the package unpatched, and a key 10.28 refuses as neither version nor
   range is refused. pnpm decides by name and version, so a patch applies to
   every instance of `name@version` in the lock, whatever its peers: there is no
   "patched here, unpatched there" in one lock.

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
     hunk (pnpm trims with `/\s+$/`, which backtracks and takes 12 s over a line
     of 80,000 spaces and a letter; opm uses `trimEnd`, which removes the same
     characters in one pass); inserted lines are written as the patch has them,
     and the file is split and joined at `\n` only (so a CRLF file patched by an
     LF patch has mixed endings, as with pnpm);
   - a new file (`new file mode 100644` or `100755`) replaces a file already at
     its path, a deleted file's text is not compared, a rename never overwrites,
     a mode change sets 644 or 755; any other mode (a symlink's `120000`) makes
     the patch unreadable, `ERR_PNPM_INVALID_PATCH`;
     - pnpm reads an `index abc..def` line with `/(\w+)\.\.(\w+)/` and a
       `diff --git a/x b/y` line with `/^diff --git a\/(.*?) b\/(.*?)\s*$/`, and
       both backtrack: one header line of 40,000 characters held `--plan` for
       5.8 s and one of 160,000 for 104 s, before any budget exists, and a patch
       file may be 16 MiB. opm reads the two lines in one pass
       (`header-lines.ts`), with the groups the regexes give (compared with them
       over 60,000 and 120,000 generated lines, line terminators and Unicode
       whitespace included), and refuses either line over 8,300 characters
       (point 13). Those two are the only header lines pnpm reads in more than
       linear time: on one line of n characters in the worst shape for each,
       pnpm 10.28's `applyPatchToDir` spends 95 to 120 ms at 9,000 and four
       times as long at each doubling (22 to 30 s at 144,000), and under 1 ms at
       288,000 on the eight others (`old mode `, `new mode `,
       `deleted file mode `, `new file mode `, `rename from `, `rename to `,
       `--- `, `+++ `), a slice and a trim, which opm reads the same way and
       does not bound
       (`reports/fix-184-r4.scripts/01-header-prefix-timing.mjs`);
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
   and the install stops. "Whole" is the failure path's promise only: a patch
   that fails forward and whose reverse would apply counts as applied (point 7),
   and the package keeps what the two runs left, as with pnpm: the files the
   forward run wrote before it failed, and any mode the dry run of the reverse
   set, since pnpm's dry run still runs `chmod`. So
   `[t: 100644 → 100755, a hunk the package already has]` is applied, and `t`
   stays 644 (`already-applied.test.ts`, with pnpm 10.28's own outcomes).

   **The work is bounded.** Like pnpm, the applier reads, splits, joins and
   writes a whole file for every section that patches it, so a patch of K
   sections that each change one line of one large file costs K times that file:
   2,000 such sections, 146 KB, against a 2 MB file ran for a minute, and a 16
   MiB patch would run for an hour. opm counts the characters it reads, compares
   and writes, the lines a splice moves, and the paths it looks up: a lookup in
   the patch's tree costs its path and each ancestor it visits (a character
   each, and one), making sure of a directory costs the parent at each level,
   and each named path and directory above it costs an `lstat` of 2,048 and its
   length. One budget runs the tree's read, the patch and, if it fails, its
   reverse, and a patch past 256 MiB of them is refused as too costly
   (`PATCH_FAILED`, exit 3); the 2,000-section patch is refused after 1.9 s.
   Without the path charges a 16 MiB patch within every other bound (one path
   128 directories deep created 4,801 times) was applied after 330 s, and 2 MiB
   of distinct deep paths took 177 s, 892,000 `lstat` calls and 375 MB; the
   first is refused as too costly after 1.5 s now, and the second at `--plan`,
   where the paths and the directories above them are held to 100,000 (point
   13).

   The costliest patch of each shape that still applies, found by bisection (4
   CPUs, load average 25 to 40, Node 22.22.0,
   `reports/fix-184-r2.scripts/17-worst-case.mjs`, re-run after round 3 with
   paths 127 segments deep, the most a patch may now name): 27 creations of a
   3,428-byte path, a patch of 94 KB, 0.8 s (0.4 s of CPU) and 89 MB resident;
   386 distinct paths 127 deep each deleted, 1.3 MB, 4.2 s of CPU and 140 MB;
   99,850 shallow files each deleted, 5.5 MB, 2.4 s of CPU and 270 MB. A shape
   that reads directories, for the twin search of point 13: one file created in
   each of 30,000 existing directories applies in 7.8 s of CPU and 197 MB, and
   in 48,000 is refused as too costly after 6.5 s of CPU
   (`21-hostile-shapes.mjs`). A package that holds a directory in every case of
   a name at two levels, 100 by 100 leaf directories, with 1,000 files created
   below it: 0.35 s of CPU (5.4 s when each file followed the directories
   again). The directories a created file's parent folds to are found, and the
   names below them merged, once for the folded path, not once for each way a
   patch spells it, so what the search holds is bounded by the package's own
   entries (at most the 100,000 its archive held) and not by the patch: one
   60,000-file directory reached in 60 spellings held 670 MB resident when each
   spelling merged it again, and holds 112 MB (0.17 s of CPU); 65,536 leaf
   directories reached in 300 spellings, refused as too costly after 4.4 s and
   463 MB before, apply in 1.7 s of CPU and 136 MB
   (`reports/review-184-r4.scripts/06-twin-shapes.mjs`, load average 17). The
   most resident memory measured over every shape here is 270 MB (99,850 shallow
   deletions, above); the reviewer's shapes peak at 219 MB (20,000 files deleted
   and the other case created beside each, 12 s of CPU), and the twin search's
   own at 136 MB. Measured at round 2, OpenSesame's four patches spend 49,836
   (`braces@3.0.3`), 13,113 (`js-yaml@3.15.2`), 189,011 (`node-forge@1.4.0`,
   most of it `lstat`) and 96,686 (`@simple-git/argv-parser@2.0.1`), and the 37
   oracle cases at most 6,241: the bound is 1,420 times the largest real patch
   (none of the four creates or renames a file, so the twin search reads no
   directory for them). A real patch changes a file in one section; run, one
   section of 500 hunks spread over a file of 9,138,889 bytes and 250,000 lines
   spends 153,019,895, 57% of the bound
   (`reports/review-184-r3.scripts/19-adr-claim-500-hunks.mjs`).

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
    for, up to ten seconds. After that the install makes the tree again from the
    unpatched entry it has proved (point 12), in a temporary directory, and
    records the entry in place only if its files are that tree: a publisher
    killed between its rename and its record leaves nothing that wedges the
    store (150 SIGKILLs at random moments over a publish: 8 left an entry with
    no record, and the next install succeeded after all 150, the 8 in 10.0 to
    10.2 s, `18-kill-publisher-heal.mjs`; before, 2 of 120 left an entry every
    later install refused until gc removed it once ten minutes old). An entry
    that is not that tree is not trusted: no record is written and the error
    names the two paths to remove. `opm gc --shared` reads the key under ADR
    0048 §8's rules: kept while a project links any of its files, kept while its
    `.tree`, or the directory itself while it has no record, is younger than the
    age rule, removed with its record otherwise, and a leftover
    `.<key>.materialize-` cleared once old, as is a `<key>.tree` whose entry is
    gone (an install or a collection that stopped between the two leaves one;
    this holds for an archive's record too). A record gc moved aside and finds
    to be one written since it judged the old one is put back and is not
    reported removed; for the instant between the two a reader finds no record,
    which a patched entry's reader makes good as above and an archive's is told,
    and runs again. While a patched copy is kept, so is the archive's entry it
    was made from, although no project links that one: an install proves the
    archive to be the package the lock names before it adopts the copy (point
    12), and an offline install has nowhere else to find it.
12. **Order.** The archive is fetched, proved against the lock's integrity,
    extracted, and proved to be the package the lock names (ADR 0055 §7)
    **before** it is patched: a patch that edits `package.json` changes what is
    installed, not what was checked. Whether a package declares an install
    script is then read from what is installed, the patched files (a patch that
    adds a `postinstall` is reported).

### What is refused, by name

13. In the order of ADR 0055 §18:
    - by the lock alone (exit 3): a key that applies to no package of the lock;
      two ranges one version satisfies; a key that is neither version nor range;
      a snapshot that does not carry the hash of its patch, or carries one no
      patch gives; a hash of neither pnpm's form;
    - by the project's files (`--plan`, before anything is fetched): a patch
      file that is not there (`NOT_FOUND`, exit 4, as pnpm's `ENOENT`); a patch
      file larger than 16 MiB, or patch files that come to more than 64 MiB
      together, sized before any is read and read to at most one byte past the
      bound (`SIZE_LIMIT`, exit 7: each is held whole, as bytes and as text,
      while the lock is read, and pnpm reads whatever is there); a path that
      leaves the project through `..` or an absolute path, or that is reached
      through a link (`UNSAFE_PATH`, exit 7); a patch pnpm cannot read
      (`INVALID_PATCH`, exit 3); and, as a stale lock (exit 3, "pnpm install
      --frozen-lockfile would refuse too"), a key added or removed, a path
      moved, a file edited. **Each path a patch names** is `UNSAFE_PATH`
      (exit 7) when it leaves its package or has an empty, `.` or `..` segment,
      a backslash or NUL; when it is **longer than a path below the package may
      be in an archive**, which is held with the directory every archive path
      begins with, `package/`, counted as the archive counts it
      (`validateArchivePath('package/' + path)`): 127 segments and 4,088 UTF-8
      bytes, an archive's 128 and 4,096 less the root; when a segment is a name
      an archive refuses on every platform (a Windows device name, with or
      without an extension, such as `CON` or `aux.js`; a `:`; a trailing dot:
      `segmentProblem`, the materializer's own rule, which both call); and,
      stricter than an archive, when a segment is over the 255 bytes a file name
      may be. The parser, as pnpm's, takes whitespace off the end of a path, so
      a name that ends in a space is the name without it. The bounds are
      `PACKAGE_TREE_LIMITS`, the ones the materializer's defaults read
      (`limits.test.ts`); `archive-rule.test.ts` holds the patch rule to
      `validateArchivePath` (the same verdict for every depth and length around
      the bounds, and nothing the patch accepts is refused by the archive over
      30,000 generated paths). **The whole path** is held too: with the
      directory the host makes the package in in front of it, the longest path
      is under 4,096 bytes (Linux's `PATH_MAX`, the NUL included; measured:
      4,095 in all is made, 4,096 is `ENAMETOOLONG`, with 330 bytes and with
      3,700 bytes of directory in front). `--plan`, and the install before it
      fetches, check the longest path the patch names against the longest
      directory the install can use: `OPM_STORE_HOME`, or the private store
      beside `node_modules`, each in the longer of its two forms, as it is
      written and with the symlinks of its existing ancestors followed (the host
      works on the canonical path, and `realpath` takes no more than 4,095 bytes
      of it either), then `.<key>.materialize-<uuid>/package`. A lock that
      patches nothing does not read the store setting. Once the package is
      fetched, the install checks again against the directory it really made, in
      the same longer form, and checks the longest path **the unpatched package
      already holds**: the patched copy is made about 120 bytes deeper than the
      archive's entry, so below a 30-byte store a package that holds a path of
      3,864 to 3,984 bytes is stored, and cannot be patched whatever the patch;
      `--plan`, which has no archive, cannot see it. Each is refused with the
      path's bytes, the directory's and the limit (`UNSAFE_PATH`, exit 7), and
      any `ENAMETOOLONG` the file system still gives while the patched copy is
      made, patched, counted or hashed is the same refusal, with nothing
      published and the temporary removed. Not checked: the paths of the
      project's `node_modules` (which can be longer than the store's), as for an
      unpatched archive; macOS's 1,024 bytes and Windows's fewer. **The paths a
      patch names and the directories above them** are held to the 100,000 files
      an archive may hold (`SIZE_LIMIT`, exit 7). A **`diff --git ` or `index `
      line** of more than 8,300 characters, two paths of 4,088 bytes and the
      `diff --git a/ b/` around them with room for trailing whitespace, is
      `SIZE_LIMIT`, wherever it is: the two lines pnpm reads with a regex that
      backtracks (point 7). The eight other header lines the parser reads, and a
      line it reads as nothing (a commit message or a mail header before the
      first diff), are taken at any length, as pnpm takes them, and a line of a
      hunk is a line of the package and has no bound. The one difference left: a
      `diff --git ` or `index ` line over 8,300 characters, in the preamble as
      well, which pnpm reads in seconds and opm refuses; a path thousands of
      directories deep makes such a line before it is looked at as a path;
    - when it is applied (the package's files are needed, so not at `--plan`): a
      patch that does not apply, or one too costly to apply (point 9)
      (`PATCH_FAILED`, exit 3); **a pair of files the patch leaves that an
      archive refuses** (`CASE_COLLISION`, reported as `UNSAFE_PATH`, exit 7),
      which `collisionKey` (the path lowercased, in adapter-core) decides for
      the materializer's `validateEntries` and here: a file the patch creates or
      renames to, against the package's files (the directories above it followed
      in every case they are spelled, `Lib` and `lib` alike) and against the
      other files the patch creates, as the patch leaves them (a file it deletes
      or moves away is not a twin, so a swap of `x.js` for `X.js`, or a rename
      that only changes case, is taken). On a host that folds case or
      normalization (macOS by default, Windows, ext4 with casefold) `lstat` of
      `lib/X.js` finds `lib/x.js`, and pnpm's rule (a new file replaces one at
      its path) would write over the twin, where extracting an archive that held
      both fails on its exclusive create; so a file the patch creates over one
      the tree found must be listed under exactly that name in its directory,
      and a file the tree found absent is created with `O_EXCL`; both are
      `CASE_COLLISION`. Linux, where the tests run, does not fold:
      `case-collision.host.test.ts` gives the check a folding host's answer and
      plants the twin between the read and the write; no macOS or Windows run
      was made. And **more files in the patched entry than an archive may
      hold**, 100,000, counted once the patch is applied and before the entry is
      hashed or published (`SIZE_LIMIT`, exit 7).

    **What this holds, and what it does not.** A patched entry has no path an
    archive could not hold in its depth, its length (with `package/`), its names
    or the pair rule above, and no more files than an archive may. The pair rule
    is the archive's own, and as weak as it: `collisionKey` is `toLowerCase`,
    which is not Unicode's simple case folding, so `ς` and `σ`, `µ` and `μ`, `ſ`
    and `s`, `ß` and `SS`, `ı` and `I` have different keys, and an archive and a
    patch both take a pair of them that NTFS or APFS, folding by their own
    tables, may make one file. Two names that differ only in Unicode
    normalization (an NFC name beside an NFD one) are two keys for the archive
    (`inspectArchive` on a tar of the two takes them; `case-collision.test.ts`
    runs it) and so for the patch: that is the archive's decision, and making
    `collisionKey` normalize is one line, a change to extraction this ADR does
    not make (on a normalizing host, the listing and `O_EXCL` checks above
    refuse what would write over such a twin). A file created beside a directory
    the same patch creates (`a/b` and `A`) is not compared: an archive whose
    directories are implied by its files' paths, as `npm pack` writes them
    (files only), takes the pair, and one with an explicit `a/` entry refuses it
    (`reports/fix-184-r4.scripts/03-archive-dir-vs-file.mjs`); against a
    directory the package already has (`lib/X` beside `lib/x/`) the patch
    refuses it, which is stricter than an npm archive. Directories that differ
    in case and hold different files (`Lib/a.js`, `lib/b.js`) are taken by an
    npm archive and by a patch, and refused by an archive with explicit `Lib/`
    and `lib/` entries. The entry's expanded size is not re-added: the patch
    adds at most its own size (16 MiB) to an entry that was held to 64 MiB when
    it was extracted.

14. **What pnpm does that opm refuses, and why:**
    - a path in the patch that leaves the package, or a link in the package on
      the way to a path it names: pnpm follows both and writes outside the
      package; opm writes only below it;
    - a path past an archive's bounds, or with a name an archive refuses: pnpm
      makes the directories whatever their depth (a 12 KB patch names a path
      2,000 deep) and creates `lib/CON` or `a:b`, and opm refuses them as it
      refuses those in an archive;
      - a `diff --git ` or `index ` line past 8,300 characters, and a patch that
        would cost more than 256 MiB of work: pnpm reads the first with a
        backtracking regex and runs the second for as long as it takes (points 7
        and 9);
    - a patch that leaves two files that differ only in case: pnpm applies it, a
      case-insensitive file system keeps one, and an archive with the pair is
      refused (point 13); and, on a host that folds case or normalization, a
      file a patch creates where `lstat` finds a twin by another name: pnpm
      writes over the twin (point 13);
    - a path that is under every bound of its own and too long with the store's
      directory in front of it, the store's canonical path counted, or a package
      that already holds a path too long for the patched copy: pnpm's `lstat`
      would be `ENAMETOOLONG` as well, and opm says so first (point 13);
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
| `opm ci --plan`, the whole lock                                              | exit 0 (was exit 3): 1,758 packages in 2,847 places from 1,739 archives, 4 packages patched by 4 patches, 71 of 71 members; the four pnpm 9 hashes match their files (again on 2026-10-17 at 6d4cdc795, after the review's fixes and #179's placement: 2,120 places, 47 members linked, 10 s)            |
| `opm ci`, the whole lock                                                     | exit 7 after 244 s, not for a patch: `sylvester@0.0.21`'s archive is a gzip stream padded with zero bytes to 30,720, which the materializer's `DecompressionStream` refuses ("Trailing junk found after the end of the compressed stream") and Node's zlib, and so npm and pnpm, accepts. Not fixed here |
| `opm ci --filter '!./tests/redteam'` (the one member that needs `sylvester`) | exit 0 in 219 s: 2,054 places of 1,305 packages, 377 archives fetched (78.4 MB) and 911 from the store, 3 packages patched by 3 patches, 47 of 71 members linked                                                                                                                                         |
| each patched package against GNU `patch -p1` 2.7.6                           | `braces@3.0.3` (4 of 10 files changed), `js-yaml@3.15.2` (1 of 36), `node-forge@1.4.0` (1 of 59): the installed directory equals the unpatched entry patched by GNU patch, file for file and executable bit for executable bit; Node resolves `braces` to the patched copy                               |
| `@simple-git/argv-parser@2.0.1`, not installed above                         | its archive from the registry, checked against the lock's sha512, patched by opm's applier and by GNU patch: the 42 files are the same, and its pnpm 9 hash is the lock's `wbmb7dwhiv66et2i6bbymnlkhi`                                                                                                   |

Costs and limits:

- **Two copies of a patched package's files** on the machine: the unpatched
  entry and the patched one. A patched package is small next to a closure, and
  linking the patched entry to the unpatched one's files would make each keep
  the other alive in `opm gc --shared`'s eyes. `opm gc --shared` keeps the
  unpatched entry for as long as it keeps the patched one (point 11), so both
  copies stay until no project links the patched one.
- **The applier is a second implementation of pnpm's.** The oracle is what keeps
  it pnpm's; a new pnpm that changes `@pnpm/patch-package` needs the generator
  run again against it, and a change to what the applier writes must change the
  store key's form (`-patch-` is the first).
- **Scripts are still not run** (ADR 0055 §21), patched or not.
- **The gzip padding of old archives** (above) blocks OpenSesame's
  `tests/redteam` until the materializer accepts what Node's zlib accepts after
  the end of a gzip stream; that is the materializer's change to make, with its
  own review.
