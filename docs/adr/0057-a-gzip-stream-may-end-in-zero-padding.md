# ADR 0057: A gzip stream may end in zero padding

- Status: Accepted
- Date: 2026-10-17
- Amends [ADR 0046](0046-a-lockfile-is-installed-not-re-resolved.md) §7 (what
  the materializer tolerates in an ecosystem's archives: zero padding after the
  gzip stream; and, §8 below, what it refuses in a tar: what npm's and pnpm's
  extractors read differently)
- Relates: [0030](0030-build-versus-buy-for-primitives.md) (the decoder is
  Node's zlib, the one npm and pnpm use, not a port),
  [0056](0056-opm-ci-applies-pnpm-patches.md) (whose end-to-end run found it)

## Context

`opm ci` on OpenSesame's lock failed on one package, `sylvester@0.0.21`:
`Trailing junk found after the end of the compressed stream`. Its registry
archive is 30,720 bytes: a gzip member that ends at byte 26,837, then 3,883 zero
bytes. GNU tar wrote compressed archives in whole 10,240-byte records and padded
the last one with zeros. The lock's sha512 is over all 30,720 bytes.

The materializer decoded `tar+gzip` with the WHATWG
`DecompressionStream('gzip')`, which refuses any byte after the stream. In Node
22 that stream is Node's own zlib: its constructor is
`createGunzip({ rejectGarbageAfterEnd: true })`
(`node -p "DecompressionStream.toString()"` on 22.22.0), so the zlib decoder
below differs from it in exactly one thing, what may follow the stream. npm
(node-tar over minizlib) and pnpm (`zlib.gunzipSync`) decode with Node's zlib,
whose `node_zlib.cc` does this after a member ends: while input remains and the
next byte is not `0x00`, reset and inflate another member; at a `0x00`, stop and
ignore the rest as padding. Measured on Node 22.22.0, for a member `M`:

| Input                    | `zlib.gunzipSync`                                  | `DecompressionStream('gzip')` |
| ------------------------ | -------------------------------------------------- | ----------------------------- |
| `M` + 10 zero bytes      | `M`'s output; the engine read `M`'s bytes only     | refused (trailing junk)       |
| `M` + `M2`               | both outputs, concatenated                         | both outputs, concatenated    |
| `M` + `JUNK`             | refused: incorrect header check                    | refused                       |
| `M` + `00 4a 55`         | `M`'s output: everything after the zero is ignored | refused (trailing junk)       |
| `M` + `00 00` + `M2`     | `M`'s output only: `M2` is dropped                 | refused (trailing junk)       |
| `M` + `1f 8b ff ff`      | refused: unknown compression method                | refused                       |
| `M` + a truncated member | refused: unexpected end of file                    | refused                       |

## Decision

1. **The gzip stream of a `tar+gzip` archive is decoded by Node's zlib**
   (`createGunzip`, in `packages/materializer/src/gzip.ts`), the decoder npm and
   pnpm extract with: the same members, the same CRC-32 and length checks. Its
   output is bounded as before (the expanded-size or ratio limit, whichever is
   smaller, checked as output arrives) and it stops when the signal aborts. A
   zip entry's deflate data is still decoded by `DecompressionStream`; nothing
   changes there.
2. **Zero bytes after the stream are accepted** as padding, as npm and pnpm
   accept them. This is the whole of the new tolerance.
3. **A second member is accepted, because Node accepts it**: its output follows
   the first's, as Node concatenates them. `DecompressionStream` already did the
   same, so no archive opm installed before is read differently now.
4. **Any other byte after the stream is refused** as `GZIP_TRAILING_DATA`, by
   offset, for example:
   `4 bytes follow the gzip stream at offset 26837; the byte at offset 26837 is 0x4a, and only zero bytes may follow it`.
   `opm ci` reports it under the package's name
   (`<name>@<version> (<path>) cannot be extracted: …`). This is **stricter than
   Node** in two cases, on purpose: a zero byte followed by any non-zero byte,
   and a member after a zero byte. Node extracts both and ignores what follows
   the zero, so an archive could carry bytes, a whole member included, that no
   extractor reads and a reviewer of the extracted tree never sees. No archive
   on the registry is known to need either.
5. **Where zlib itself refuses**, the refusal names the cause and the offset.
   The members are walked and checked as zlib checks them: the RFC 1952 header
   (with its CRC when FHCRC is set), the deflate data (inflated to find where it
   ends), the trailer's CRC-32 and length. The first member that fails any of
   them is the refusal, `INVALID_COMPRESSION` "<zlib's reason>, in the gzip
   member at offset N", and the walk goes no further, so it never blames bytes
   after a member zlib refused. After members that pass, the first byte that is
   neither another member's header nor zero is `GZIP_TRAILING_DATA`. The walk
   only words a refusal: what is accepted is decided by zlib and the zero scan,
   never by it. It has its own bounds, 1,024 members and an output budget (the
   decoder's limit, spent member by member); past either it gives zlib's reason
   with no offset. An abort while it runs surfaces as the abort, never as a
   refusal.
6. **Nothing hashed changes, and the hash comes first.** The archive's integrity
   is checked over every byte, padding included, before it is decoded (the
   materializer's digest, and the sha512 a lock pins); changing one padding byte
   is `DIGEST_MISMATCH`. The padding counts toward `maximumCompressedBytes`, and
   the scan reads only bytes already held within it.
7. **Padding buys no acceptance.** After decoding, the compression ratio is
   measured against the gzip stream alone, without the padding, so zeros
   appended to a small stream do not raise how far it may expand **and still be
   accepted**. While it decodes, the decoder's limit is still the expanded-size
   limit or the ratio times the bytes downloaded, padding included, whichever is
   smaller: a refused archive may be decoded that far before it is refused, as
   any archive of that length may be. The unpadded length is not used for that
   limit because it is not known before decoding: the last non-zero byte is only
   a lower bound on where the stream ends (a trailer's length, and deflate data,
   can end in zero bytes), so a limit taken from it could refuse an archive the
   ratio check accepts.
8. **For npm's archives, opm refuses the classes of archive on which the two
   reference extractors install different files.** Found by the same review and
   narrowed, round by round, to what the tests below prove. npm extracts with
   node-tar 6.2.1 and pnpm 10.28.0 with its own `parseTarball`. A tar that the
   rule covers is refused with a typed code, installing neither set, in each
   class listed here; where the two agree, opm extracts what both extract,
   except in the three cases listed after the classes. "Install different files"
   is one definition throughout: the files each installs from the same bytes, as
   path and content with the first path component stripped, or pnpm throwing.
   The claim is as strong as the 71 archives of
   `packages/materializer/test/tar-oracle/` (each read by both extractors,
   recorded in `oracle.json`, re-run by `generate.mjs --check`) and no stronger:
   the classes were found by reading the two sources and by differential
   fuzzing, neither of which can show there is no other. Two further sections
   say what the definition leaves out on purpose: pacote's filter, and archives
   npm extracts that pnpm itself cannot read.

   **Where the rule applies.** The npm adapter asks for it by name, as it asks
   for `acceptRedundantEntries`: `requireNpmReaderAgreement` in the
   materializer's limits. It is set for an npm lock's and a pnpm lock's tarballs
   (`opm ci`: the frozen lock's `extraction`, from `adapter-npm`), for an npm
   package `opm add` or `opm install` fetches (`installArchiveLimits('npm')`,
   through the shared store and directly), for npm bin discovery, and for
   `openpacker materialize --install-prefix` when the artifact's type is the npm
   adapter's (`application/vnd.openpacker.npm.package.`;
   `apps/openpacker-cli/src/extraction.ts`). The daemon extracts nothing: its
   `materialize` operation returns the descriptor and its restrictions. It is
   never guessed from the archive's bytes. The two shared-store functions that
   extract take `limits` as a required argument (a call without it does not
   compile), so a caller cannot fall back to the materializer's defaults by
   forgetting it. Every other tar (a crate, an sdist, an OCI layer, a plugin,
   another ecosystem's lock) keeps the general rule below.

   **The general rule.** The archive ends at two zero blocks in a row or at the
   end of the data; whatever follows two zero blocks is not read; the checksum
   is read over its 8 bytes and the prefix is joined whatever the magic. A tar
   with no zero block at its end extracts, and so does one padded with any
   length of zeros. A lone zero block that anything but zeros follows is refused
   (`TAR_AMBIGUOUS_END`) in every ecosystem. Evidence, run on 2026-10-17 on
   `[a][Z][b][Z][Z]`: GNU tar 1.35 lists `a` and warns "A lone zero block at 3",
   Python 3.13's `tarfile` lists `a`, Go 1.24's `archive/tar` returns `a` and
   then `invalid tar header`, node-tar lists `a` and `b`; the stack's base build
   (484dc82) returned `a`, the first answer to the review (1d33ec4) `a` and `b`.
   GNU tar does not read past a lone zero block. Rust's `tar` crate was not run.
   No reading of the second entry is safe, so none is made.

   **The classes refused in npm mode**, each with its oracle cases (a case is
   refused if and only if it is one the two read differently, plus the
   over-refusals below):
   - **The end, `TAR_AMBIGUOUS_END`.** pnpm stops at the first header position
     whose first byte is 0 and reads a header past the end of the data (and
     fails). node-tar ends at two null blocks in a row or at the end of the
     data, and skips a lone null block and a block whose checksum fails. opm
     refuses a lone zero block followed by an entry, a zero block before the
     first entry, data that ends with no zero block, and a header whose name
     starts with NUL with its path in the prefix. The decision is one pass over
     the rest of the archive with node-tar's checksum reading and null-block
     rule, made once, at the first zero byte in header position. It assumes
     node-tar is at the same offset as opm. The checksum, directory, number,
     link-name and type classes below refuse the headers this review found after
     which it would not be, and the fuzz found no other.
   - **The checksum, `TAR_AMBIGUOUS_CHECKSUM`.** node-tar reads the field over
     12 bytes, into the typeflag and the link name; pnpm and opm over its 8.
   - **The prefix, `TAR_AMBIGUOUS_PREFIX`.** node-tar joins the prefix to the
     name only under `ustar\0` `00` magic; pnpm and opm always do.
   - **A directory, `TAR_AMBIGUOUS_DIRECTORY`.** node-tar takes a directory's
     size, and the size of a file named with a trailing slash, for 0 and reads
     the next block as a header; pnpm and opm skip the size. A sized directory
     hides the entries in its span from pnpm and opm (a payload that starts with
     NUL, as every `.wasm` does, was accepted by the end rule above for the same
     reason). A directory with a size is refused, and so is a type `0` or NUL
     entry whose path ends in a slash at any size (node-tar makes a directory of
     it, pnpm installs a file).
   - **A number, `TAR_AMBIGUOUS_NUMBER`.** node-tar decodes uid, gid and mtime
     in every header, devmajor and devminor under `ustar\0` `00` magic, and
     atime and ctime there when byte 475 is zero; a base-256 number it cannot
     decode (a first byte with the high bit set that is not 0x80 or 0xff, or a
     value that is not a safe integer) makes it drop the entry and read the
     entry's data as headers. pnpm and opm install the entry. A valid base-256
     number is accepted. A base-256 size or mode was already refused
     (`ADAPTER_REQUIRED`).
   - **A link name, `TAR_AMBIGUOUS_LINK`.** node-tar drops a header that is no
     link and has a link name ("linkpath forbidden") and reads its data as
     headers; pnpm and opm install it. That includes an extended header, whose
     path record node-tar then ignores. It includes a directory, which holds no
     file but is dropped before node-tar clears a pending extended header, so
     `[x path=X.js][directory with a link name][decoy.js]` installs `X.js` with
     npm and `decoy.js` with pnpm and opm. A directory with a link name is
     therefore refused, whether or not an extended header precedes it.
   - **An extended header, `TAR_AMBIGUOUS_PAX`.** (1) An extended header (`x`)
     with a path or a size, then a global header (`g`), then an entry: node-tar
     and opm name the entry by the extended path; pnpm applies the path to the
     global header. (A comment-only extended header is accepted.) (2) A record
     with a newline in it, in an `x` or a `g`: node-tar splits the header at
     newlines and keeps a line only if its length prefix counts exactly that
     line, so it ignores a record whose value holds a newline and applies a
     record smuggled inside another record's value; pnpm and opm cut by the
     length prefix.
     `[index.js=BENIGN][x path="package/z\nz.js"][index.js=PAYLOAD]` installs
     `index.js=PAYLOAD` with npm and `index.js=BENIGN` plus a file `z\nz.js`
     with pnpm and opm; a smuggled `size=1` gives npm a one-byte body and makes
     it read the rest as headers.
   - **A type, `TAR_AMBIGUOUS_TYPE`.** Typeflag `7` (a contiguous file) is
     extracted by node-tar and opm; pnpm throws "Unsupported file type 55".
   - **A path, `TAR_AMBIGUOUS_PATH`.** A file whose path has a backslash:
     node-tar keeps it in the name, or drops a single-component path; pnpm trims
     the first component at it; opm reads it as a separator, so the file lands
     at a path no other reader uses. A file whose path has no slash: node-tar's
     strip drops it, pnpm installs it.

   **Refused although the two agree (accepted over-refusals, each an oracle case
   in `OVER_REFUSED`).** opm cannot tell, without re-implementing node-tar's
   whole header acceptance, that what it refuses yields no file: a zero block in
   header position followed by a header node-tar reads but that yields no file
   (one with no path, a directory, a base-256 checksum it cannot decode:
   `TAR_AMBIGUOUS_END`); a directory header node-tar drops for its checksum
   reading or an unreadable number, and a sized directory whose span holds
   nothing; an extended header with a size equal to its entry's, then a global
   header, and an extended header's path, a global header, then a directory; a
   directory with a link name that no extended header precedes; a newline in a
   pax record that changes nothing (a comment's value, a key); a prefix without
   `ustar\0` `00` magic that a pax path overrides; a backslash below the
   top-level directory. None of these, and none of the refused classes, occurs
   in the registry samples below.

   **Extracted although the layouts differ, a known non-security difference
   (pinned by `PINNED` in `tar-end.test.ts`).** An entry whose name starts with
   `./`: all three read the same names, opm drops the `.` segment as npm's
   extractor does for any other (`acceptRedundantEntries`), and the layout
   (`treeToInstall`: one top-level directory is unwrapped, otherwise the store
   root is installed) then decides where files go, where npm strips the first
   component, `.`, and keeps `package/`. A second top-level directory
   (`other/o.js` beside `package/a.js`): npm and pnpm merge them; opm extracts
   both and the layout installs the root. In both, the file is in the installed
   tree at a path other than npm's; none is hidden from a reader of that tree.

   **Archives npm extracts and pnpm cannot read.** Real packages exist that npm
   installs and pnpm itself fails on, and the rule refuses them in npm mode as
   stated. Found: `@codemirror/streamparser@0.0.0-stage` (one of 2,000 registry
   archives scanned in the fourth review), a 2,560-byte tarball whose last file
   ends the data with no end-of-archive block: npm extracts `README.md` and
   `package.json`; pnpm throws `Invalid checksum for TAR header at offset 2560`.
   What the operator sees: `opm ci` stops at that package with
   `<name>@<version> (<path>) cannot be extracted: Unsafe archive rejected (TAR_AMBIGUOUS_END): the data ends at offset 2560 with no zero block: pnpm reads a header past it and fails, npm ends there`,
   and installs nothing from it (`opm add` and `opm install` refuse it with the
   same code). The remedy is outside opm on purpose: install that package with
   npm, take another version of it, or ask its publisher to republish a tarball
   with an end-of-archive block (which pnpm needs too). There is no switch to
   accept it; accepting such an archive would be a new decision of this ADR's
   kind, not a configuration. Under the general rule (any other ecosystem) the
   same bytes extract.

   **What pacote's filter changes.** npm does not write what node-tar's `Parse`
   reads: pacote 19.0.1 (`lib/fetcher.js`) extracts with a filter that skips
   links and every entry that is not a file, and renames a `.gitignore` to
   `.npmignore`, or drops it if a `.npmignore` came first. The oracle therefore
   records both: `nodeTar` (what `Parse` reads, which the definition above
   compares) and `pacote` (what `tar.x` writes with that filter, to a
   directory). `tar-end.test.ts` holds them equal for all 71 cases but for three
   ignore-file cases it lists (and a trailing slash that the file system drops).
   The filter works on names and types after node-tar has read the header, so it
   cannot turn a disagreement about which entries exist into an agreement or
   back, and it leaves the contents alone. What it can change is the name of an
   inert ignore file, for every tarball however it is read: with a `.gitignore`,
   npm writes `.npmignore` where pnpm and opm write `.gitignore`. That is not a
   disagreement about how the tar is read, so it is not refused and not modelled
   in opm.

   This replaces the first answer to the review, which skipped a lone zero block
   and extracted the entries after it as npm does, and so installed, from a pnpm
   lock, files pnpm itself never installs, and the second, whose end rule
   assumed node-tar at opm's offset and whose claim covered five shapes it did
   not refuse.

## Consequences

- OpenSesame's lock installs whole, `tests/redteam` and `sylvester@0.0.21`
  included. Each run: linux-x64, Node 22.22.0, a 4-CPU VM under other agents'
  load, `git archive` of OpenSesame's main and an empty store, both on tmpfs,
  `opm ci` with no `--filter`; each exits 0 with 2,847 places from 1,739
  archives fetched (639.1 MB), 4 packages patched by 4 patches, 47 of 71 members
  linked, 193 optional packages for other platforms left out, and
  `node_modules/sylvester` holding the archive's 20 files and loading
  (`Matrix.create([[1,2],[3,4]]).determinant()` is `-2`):

  | Code                                                    | OpenSesame  | Wall    | Load average |
  | ------------------------------------------------------- | ----------- | ------- | ------------ |
  | the padding fix (§1 to §7)                              | `44a81f2de` | 741 s   | 50 to 57     |
  | after the first review (lone zero skipped)              | `7afd8025b` | 936.5 s | about 44     |
  | after the second review (§8 before the round-4 scoping) | `034ff40d5` | 1,290 s | 39 to 45     |

  The end-to-end has not been re-run on the code of §8 as it now stands; the
  last run predates the round-4 scoping and every class added since. The
  evidence for those is the oracle, the fuzz and the registry sample below.

- Tests, in `packages/materializer/src/`: `gzip-padding.test.ts` (padding, junk,
  junk behind padding, a member behind padding, two members, a damaged member,
  the size bound, the ratio, the digest); `gzip.test.ts` (400 seeded cases
  against `zlib.gunzipSync`: opm accepts exactly what Node accepts with only
  zeros after what Node read, with the same output, and refuses the rest with
  the code each case was built for; the decoder's output bound at the bound, and
  refused as output arrives; abort); `gzip-walk.test.ts` (CRC-32, length and
  header CRC named at their member, each optional header field alone, a cut
  trailer, the walk's budget, alone and as gunzipArchive sets it, its member
  count, an abort at each of its checks); `tar-end.test.ts` (against the 71
  archives of `test/tar-oracle/oracle.json`: with `requireNpmReaderAgreement`,
  opm refuses exactly the cases where npm and pnpm install different files, with
  the code, plus the listed over-refusals (`OVER_REFUSED`, each a case where
  they agree), and extracts node-tar's set where they agree, but for the pinned
  layout differences (`PINNED`), and holds what `tar.x` writes with pacote's
  filter equal to what `Parse` reads but for the three ignore-file cases it
  lists; without it, a tar with no end block, one with a sized directory, an
  8-digit checksum and a prefix without magic extract under the general rule, a
  lone zero block that data follows is refused, and any length of zero padding
  after the end is accepted); `tar-numbers.test.ts` (which fields node-tar
  decodes, under what magic, and which base-256 numbers it reads, at the
  safe-integer bound, positive and negative, in 8 and 12 bytes);
  `tar-fields.test.ts` (a name or prefix that is not UTF-8 is
  `INVALID_TAR_TEXT`, not a bare `TypeError`); in `packages/opm-project/test/`,
  `frozen-install.gzip-padding.test.ts` (an install, the refusal by package and
  offset, the lock's integrity over the padding),
  `frozen-install.tar-agreement.test.ts` (a pnpm lock's archive with no end
  block is refused under its name), `install-limits.test.ts` (the option for npm
  and for no other ecosystem) and `shared-store.limits.test.ts` (tsc over a
  fixture: a shared-store call without `limits` does not compile); in
  `packages/adapter-npm`, both lock readers' `extraction`; and in
  `apps/openpacker-cli/test/install-prefix.test.ts` (an npm artifact is
  extracted under the agreement and refused with its code; any other artifact
  under the general rule).
- The differential fuzz, two rounds. Round 5: 103,970 archives composed from
  headers, bodies, zero, null, junk, partial and meta blocks, read by node-tar
  6.2.1, pnpm 10.28.0 and opm in npm mode (96,000 random in the `all`, `mix`,
  `pax`, `type`, `zero`, `num` and `name` families, 12,000 of them with the `./`
  spellings removed, and 7,970 enumerated: checksum fields, zero blocks at every
  position, partial blocks, magic and prefix, numeric fields, meta headers). It
  found no divergence besides the `./` spellings, but its generator never
  composed a pax body with a newline in a record or a directory with a link
  name, and those were the two classes it missed (the fourth review found them
  with `pax2c` and `dir2c`). Round 6, after the fix: 46,864 archives, 18,000 in
  the families `pax2c` (pax headers of newline, smuggled and ordinary records
  before a file), `dir2c` (directories with and without link names, sized,
  slash-named, before and after an extended header), `pax2`, `special` (GNU and
  vendor typeflags with bodies), and two of the fixer's, `pax3c` (length
  prefixes off by one and with a leading zero, empty values, CR, tab, NUL and
  `=` in values, multibyte paths with a byte and a character count, duplicate
  keys, bodies that fill a block exactly) and `order2c` (extended, global,
  directory and file headers in any order); 24,000 in `all`, `mix`, `pax`,
  `type`, `zero`, `num`, `name` (`./` spellings removed) and `oct`; and the
  4,864-archive enumeration of meta headers. 0 archives on which node-tar and
  pnpm disagree and opm extracts, 0 on which they agree and opm extracts a
  different set. Before the two fixes the same generators (seed 81; the runs
  above use 91) gave 413 and 296 such archives in `pax2c` and `dir2c` and 24 in
  `order2c`. The fixer also ran 44 hand-built pax and header shapes through the
  real `tar.x`, pnpm and opm (length prefixes one too long, one too short, with
  a leading zero and across a digit boundary; empty path, comment, size and
  header; bodies of 511, 512, 513 and 1,024 bytes; `x` then `x`; `g` at the
  start, after a file and at the end; duplicate path and size records;
  multibyte, CR and space values; a path ending in a newline): all agree or are
  refused. Not covered by any of it: what the generators do not compose
  (compressed members, sparse files, GNU long names, which are
  `ADAPTER_REQUIRED`); the fuzz cannot show there is no other class.
- A sample of 475 registry archives, the first, one-third, two-thirds and last
  version of 119 packages, 2010 to now, at most 25 MiB unpacked (run on
  2026-10-17, this code against 1c0051c, in npm mode and under the general
  rule): none holds a lone zero block; no archive that 1c0051c extracted is
  refused and none it refused is extracted, in either mode. 469 extract; the 6
  refused (5 symlinks, 1 over the ratio) are refused by both.
- A sample of 386 registry archives, the first three versions and one from the
  first third of the versions of 97 packages, most from 2010 to 2014
  (`registry-tar-end.mjs` from the second review, run on 2026-10-17 against this
  ADR's code, the stack's base 484dc82 and the ADR's first revision 1d33ec4):
  none holds a lone zero block or any other shape §8 refuses, and none is
  refused that either earlier build accepted. 54 of them end their gzip stream
  with zero padding; the base refused each (`INVALID_COMPRESSION`) and they now
  extract. The 15 still refused are refused by all three builds, for reasons
  outside this ADR (11 symlinks, 2 hard links, 2 over the ratio).
- A package whose archive hides bytes behind its padding installs with npm and
  pnpm and is refused by opm. If one turns up, the refusal names it and the
  offset; accepting it would be a new decision, not a bug fix.
