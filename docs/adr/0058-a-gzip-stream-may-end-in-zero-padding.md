# ADR 0058: A gzip stream may end in zero padding

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
   reference extractors read different files, as far as the tests below show.**
   Found by reviews and narrowed, round by round, to what the tests prove. npm
   extracts with node-tar 6.2.1 and pnpm 10.28.0 with its own `parseTarball`.
   "Read different files" is one definition throughout: the files each reads
   from the same bytes, as path and content with the first path component
   stripped, or pnpm throwing, or node-tar's answer changing with how it is fed.
   node-tar is read as one buffer and in pieces of 1, 1,460, 16,384 and 65,536
   bytes, and the readers differ if any of those five answers is not pnpm's.
   What is claimed: of the 94 archives of
   `packages/materializer/test/tar-oracle/` (each read by both readers, recorded
   in `oracle.json`, re-run by `generate.mjs --check`), the 50 on which the
   readers differ are refused, each with the code `tar-end.test.ts` names; 16 on
   which they agree are refused as well (listed below); 1 extracts with a layout
   other than npm's (pinned below); the other 27 extract the files node-tar
   reads. Nothing is claimed for an archive that none of the 94 resembles. The
   classes were found by reading the two sources, by review and by differential
   fuzzing; `packages/materializer/test/tar-fuzz` is the fuzzing that is in the
   repository, and what it ran is under Consequences. A fuzz can find archives
   the readers read differently and cannot show there are none. Two further
   sections say what the definition leaves out on purpose: pacote's filter, and
   archives npm extracts that pnpm itself cannot read.

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

   **A byte order mark is kept, in every ecosystem.** `TextDecoder` strips a
   leading U+FEFF unless told not to; node-tar and pnpm keep it, so a name or a
   pax key that begins with one is a different string from the same text without
   it. The decoders of a header's text and of a pax body now keep it
   (`ignoreBOM: true`; `tar-fields.test.ts`, `pax.test.ts`, the oracle's BOM
   cases), and so does the checksum field's, for consistency: its `trim()`
   removes a U+FEFF anyway, so no test can tell that one apart. Before, opm read
   `<U+FEFF>package/x.js` as `package/x.js`.

   **The classes refused in npm mode**, each with its oracle cases (the cases
   the two read differently are refused; the over-refusals follow the classes):
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
     link-name, text and type classes below refuse the headers found after which
     it would not be; the fuzz families under Consequences found no other, and
     cannot show there is none.
   - **The checksum, `TAR_AMBIGUOUS_CHECKSUM`.** node-tar reads the field over
     12 bytes, into the typeflag and the link name; pnpm and opm over its 8.
     pnpm's `parseOctal` of those 8 bytes must also give the computed sum: a
     field that holds a line feed and then a space and digits is a number to
     node-tar and opm and a failure for pnpm, and is refused.
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
     (`ADAPTER_REQUIRED`). The size field is read by three functions that cut it
     differently: opm's `tarNumber`, pnpm's `parseOctal` (copied byte for byte
     from the 10.28.0 bundle into `tar-octal.ts`, with its source named there)
     and node-tar's `decSmallNumber`. A size they do not read as one number is
     refused: a NUL and then digits (pnpm skips the NUL and reads the digits;
     node-tar and opm read 0, and node-tar reads the body as headers), a line
     feed or a tab and then a space and digits (node-tar and opm read the
     number; pnpm fails).
   - **A link name, `TAR_AMBIGUOUS_LINK`.** node-tar drops a header that is no
     link and has a link name ("linkpath forbidden") and reads its data as
     headers; pnpm and opm install it. That includes an extended header, whose
     path record node-tar then ignores. It includes a directory, which holds no
     file but is dropped before node-tar clears a pending extended header, so
     `[x path=X.js][directory with a link name][decoy.js]` installs `X.js` with
     npm and `decoy.js` with pnpm and opm. A directory with a link name is
     therefore refused, whether or not an extended header precedes it.
   - **A text field, `TAR_AMBIGUOUS_TEXT`.** node-tar cuts a name, a link name
     or a prefix with `replace(/\0.*/, '')`: the pattern has no `s` flag, so `.`
     does not match a line feed, a carriage return, U+2028 or U+2029, and what
     follows the first NUL is kept once such a character appears. pnpm and opm
     cut at the NUL. A name, a link name or a prefix with any byte other than
     NUL after its first NUL is refused (a prefix is read under `ustar\0` `00`
     magic only, 130 bytes of it when byte 475 is zero and 155 otherwise). A
     link name of a NUL, a line feed and any text is a link name on a file to
     node-tar, which drops the entry ("linkpath forbidden") and reads its data
     as headers; the oracle holds the case where that data forges `index.js`.
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
     it read the rest as headers. (3) A header of more than one block (over 512
     bytes) with a byte past 0x7f in its body: node-tar decodes an `x` or `g`
     body piece by piece as it is fed (`this[META] += chunk`), a piece handed to
     a meta entry is 512 bytes or more, and a body of one block is always
     delivered whole. A character cut in two by a piece boundary becomes two
     U+FFFD and its record is ignored, so node-tar's answer depends on how the
     archive reached it (a decompressor's output chunk, a network read, a file
     read), where pnpm and opm read the record. The oracle holds five archives
     of this kind, fed whole and in pieces of 1, 1,460, 16,384 and 65,536 bytes;
     two read differently in pieces (a character across offset 512 of the body,
     in pieces of 1 byte; across offset 16,384, in pieces of 1 and of 16,384).
     (4) A length prefix with a leading zero (`0023 path=package/X.js`) and a
     record whose last byte is not a newline are malformed
     (`INVALID_PAX_HEADER`): node-tar ignores the record, pnpm applies it.
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
   directory with a link name that no extended header precedes; a link name on a
   global header, which node-tar drops; a newline in a pax record that changes
   nothing (a comment's value, a key); a prefix without `ustar\0` `00` magic
   that a pax path overrides; a backslash below the top-level directory; bytes
   after the first NUL of a name that hold no line terminator; a pax header over
   one block with a byte past 0x7f that no piece boundary can split. None of the
   classes above, and none of these over-refusals, refuses an archive of the
   475-archive registry sample under Consequences.

   **Extracted although the layouts differ, a known non-security difference
   (pinned by `PINNED` in `tar-end.test.ts`).** An entry whose name starts with
   `./`: all three read the same names, opm drops the `.` segment as npm's
   extractor does for any other (`acceptRedundantEntries`), and the layout
   (`treeToInstall`: one top-level directory is unwrapped, otherwise the store
   root is installed) then decides where files go, where npm strips the first
   component, `.`, and keeps `package/`. A second top-level directory that holds
   a file (`other/o.js` beside `package/a.js`): npm and pnpm merge them; opm
   extracts both and the layout installs the root. In both, the file is in the
   installed tree at a path other than npm's; none is hidden from a reader of
   that tree. A top-level directory entry with no file in it (`other/`) installs
   nothing under npm's strip, and the layout (`treeToInstall`) no longer counts
   it as a second top-level directory: the package is installed from `package/`,
   as npm and pnpm install it (`layout-write.wrapper.test.ts`; before,
   `node_modules/dep/package/index.js`).

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
   directory). `tar-end.test.ts` holds them equal for all 94 cases but for three
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
  against `zlib.gunzipSync`: in each, opm accepts what Node accepts with only
  zeros after what Node read, with the same output, and refuses the rest with
  the code the case was built for; the decoder's output bound at the bound, and
  refused as output arrives; abort); `gzip-walk.test.ts` (CRC-32, length and
  header CRC named at their member, each optional header field alone, a cut
  trailer, the walk's budget, alone and as gunzipArchive sets it, its member
  count, an abort at each of its checks); `tar-end.test.ts` (against the 94
  archives of `test/tar-oracle/oracle.json`: with `requireNpmReaderAgreement`,
  opm refuses the 50 cases on which node-tar (whole or in pieces) and pnpm read
  different files, with the code the test lists, and the 16 listed over-refusals
  (`OVER_REFUSED`, each a case where they agree), and extracts node-tar's set on
  the rest but for the one pinned layout difference (`PINNED`); it holds what
  `tar.x` writes with pacote's filter equal to what `Parse` reads but for the
  three ignore-file cases it lists; without the option, a tar with no end block,
  one with a sized directory, an 8-digit checksum and a prefix without magic
  extract under the general rule, a lone zero block that data follows is
  refused, and any length of zero padding after the end is accepted);
  `tar-text.test.ts` (a byte after the first NUL of a name, a link name and a
  prefix, with the prefix's 130 and 155 bytes and its magic);
  `tar-octal.test.ts` (opm's, pnpm's and node-tar's readers of a size field, row
  by row, and the sizes refused); `tar-pax-agreement.test.ts` (a newline in a
  record, and the 512 and 513-byte bounds of a body with a byte past 0x7f);
  `pax.test.ts` (malformed records, among them a length with a leading zero and
  a record with no final newline, and a byte order mark in a key);
  `tar-numbers.test.ts` (which fields node-tar decodes, under what magic, and
  which base-256 numbers it reads, at the safe-integer bound, positive and
  negative, in 8 and 12 bytes); `tar-fields.test.ts` (a name or prefix that is
  not UTF-8 is `INVALID_TAR_TEXT`, not a bare `TypeError`; a leading byte order
  mark is kept); `zip-names.test.ts` (a zip entry name with the UTF-8 flag set
  that is not UTF-8 is `INVALID_ZIP_NAME`, not a bare `TypeError`); in
  `packages/opm-project/test/`, `frozen-install.gzip-padding.test.ts` (an
  install, the refusal by package and offset, the lock's integrity over the
  padding), `frozen-install.tar-agreement.test.ts` (a pnpm lock's archive with
  no end block is refused under its name), `install-limits.test.ts` (the option
  for npm and for no other ecosystem) and `shared-store.limits.test.ts` (tsc
  over a fixture: a shared-store call without `limits` does not compile); in
  `packages/adapter-npm`, both lock readers' `extraction`; and in
  `apps/openpacker-cli/test/install-prefix.test.ts` (an npm artifact is
  extracted under the agreement and refused with its code; any other artifact
  under the general rule).
- The differential fuzz that is in the repository,
  `packages/materializer/test/tar-fuzz` (`run.mjs`, families in `families.mjs`;
  its README says how to run it). It reads each archive with node-tar 6.2.1 fed
  whole and in pieces of 1, 1,460, 16,384 and 65,536 bytes, with pnpm 10.28.0's
  `parseTarball` (in a worker, under a 3-second deadline, because it spins on an
  `x` header whose size runs past the data) and with opm in npm mode, and with
  `--pacote` also checks the files opm returns against what `tar.x` writes with
  pacote's filter. It fails (exit 1) on an archive the readers read differently
  that opm extracts, and on one the readers agree on that opm extracts as
  another set. Run on 2026-10-17, Node 22.22.0, every family below with
  `--pacote` on the code of this ADR, and without it on `bf75b25`, the code
  before the fifth review's fixes (R15 to R18); the seeded families with seed 1:

  | Family        | What it builds                                                                                                                                                                                                                                                          | Archives | Failures on this code | Failures on `bf75b25` |
  | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------------------- | --------------------- |
  | `byte-sweep`  | every header byte but the checksum's set to each of 15 values (NUL, LF, CR, space, `0`, `1`, `7`, `8`, `+`, `-`, `/`, backslash, 0x80, 0xef, 0xff), in four archives (a file whose body is an entry, a plain file, a file with a ustar prefix, a pax header)            | 30,240   | 0                     | 2,113                 |
  | `field-bytes` | 1 to 3 runs of 1 to 4 bytes in the text and number fields of five bases, the checksum right or written one of six other ways                                                                                                                                            | 20,000   | 0                     | 274                   |
  | `pax-records` | 1 to 4 pax records from 15 shapes (newline in a path, a record inside a record, a length with a leading zero or off by one, no final newline, an empty path, a byte order mark in a key, comments of up to 1,300 bytes, with and without a byte past 0x7f), then a file | 20,000   | 0                     | 507                   |
  | `pax-cut`     | a path with a two-byte character, after padding swept across every offset around 2,048, 2,560, 2,920, 4,380, 16,384 and 32,768                                                                                                                                          | 246      | 0                     | 6                     |
  | `meta-order`  | every pair and every triple of 16 meta headers and files                                                                                                                                                                                                                | 4,864    | 0                     | 0                     |
  | `zero-blocks` | zero and null blocks between entries and after them, partial blocks of three kinds at 17 lengths, a pair of files cut every 37 bytes                                                                                                                                    | 1,183    | 0                     | 0                     |

  The 2,113 on `bf75b25` for `byte-sweep` is the number the fifth review found
  with its own copy of the same sweep. Of the 507 in `pax-records`, 506 are a
  byte order mark in a key that opm stripped and the readers kept (R16). The
  last two families found nothing on either side: they cover orders of headers
  that earlier rounds had already closed. What the families vary is what the
  table says and nothing more: no compressed members, sparse files or GNU long
  names (`ADAPTER_REQUIRED`), no header with more than a few fields changed, and
  none of them reaches every archive. A run with no failure is not a proof that
  there is none. Earlier rounds ran other generators, 103,970 and then 46,864
  archives, that are not in the repository; their figures are not repeated here
  because they cannot be reproduced from it, and what they found is in the
  oracle.

- A sample of 475 registry archives (the first, one-third, two-thirds and latest
  version of 119 packages, 2010 to now, at most 25 MiB unpacked), run on
  2026-10-17 on the code of this ADR in npm mode and under the general rule,
  against `bf75b25` and against `1c0051c`: none holds a lone zero block, and no
  archive either earlier build extracted is refused and none it refused is
  extracted, in either mode, so no rule of section 8 (R15 to R18 included)
  refuses an archive of the sample. 469 extract; the 6 refused (5 symlinks, 1
  over the ratio) are refused by all three. The script is not in the repository,
  and a later run draws the then-latest versions.
- A sample of 386 registry archives, the first three versions and one from the
  first third of the versions of 97 packages, most from 2010 to 2014
  (`registry-tar-end.mjs` from the second review, run on 2026-10-17 against the
  code of that review, the stack's base 484dc82 and the ADR's first revision
  1d33ec4; not re-run since, and the script is not in the repository): none
  holds a lone zero block or any other shape §8 then refused, and none is
  refused that either earlier build accepted. 54 of them end their gzip stream
  with zero padding; the base refused each (`INVALID_COMPRESSION`) and they now
  extract. The 15 still refused are refused by all three builds, for reasons
  outside this ADR (11 symlinks, 2 hard links, 2 over the ratio).
- A package whose archive hides bytes behind its padding installs with npm and
  pnpm and is refused by opm. If one turns up, the refusal names it and the
  offset; accepting it would be a new decision, not a bug fix.
