# ADR 0058: A gzip stream may end in zero padding

- Status: Accepted
- Date: 2026-10-17
- Amends [ADR 0046](0046-a-lockfile-is-installed-not-re-resolved.md) §7 (what
  the materializer tolerates in an ecosystem's archives: zero padding after the
  gzip stream; and, §8 below, what it refuses in a tar: what npm's and pnpm's
  extractors read differently)
- Relates: [0030](0030-build-versus-buy-for-primitives.md) (the decoder is
  Node's zlib, the one npm and pnpm use, not a port),
  [0057](0057-opm-ci-applies-pnpm-patches.md) (whose end-to-end run found it)

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
8. **For npm's archives, opm refuses the classes of archive on which the
   reference extractors read different files, as far as the tests below show.**
   Found by six rounds of review and narrowed, round by round, to what the tests
   prove. The readers: npm 10.9.4 extracts with node-tar 6.2.1 and npm 11 with
   node-tar 7.5.22, each as `tar.x` with pacote 19.0.1's filter; pnpm 10.28.0
   with its own `parseTarball`. "Read different files" is one definition
   throughout: the files each reader installs from the same bytes, as path,
   content and execute bit, the first path component stripped; or a reader
   failing. Each node-tar line is read as `Parse` fed one buffer and in pieces
   of 1, 1,460, 16,384 and 65,536 bytes and as `tar.x` writing to a directory,
   and the readers differ if any of those twelve readings is not pnpm's
   (pacote's renaming of an ignore file aside, below). What is claimed: of the
   117 archives of `packages/materializer/test/tar-oracle/` (each read by every
   reader, recorded in `oracle.json`, re-run by `generate.mjs --check`), the 63
   on which the readers differ are refused, each with the code `tar-end.test.ts`
   names; 22 on which they agree are refused as well (listed below); 1 extracts
   with a layout other than npm's (pinned below); the other 31 extract the files
   and execute bits node-tar reads. Nothing is claimed for an archive that none
   of the 117 resembles. The rule has two layers: targeted checks, each a
   difference between the decoders found by reading their source or by fuzzing
   (the classes below), and a list of the spellings real writers give each
   header field, outside which a header is refused whether or not a check names
   the difference (the spelling layer, below). A fuzz can find archives the
   readers read differently and cannot show there are none; the fuzz in the
   repository and what it ran are under Consequences. Further sections say what
   the definition leaves out on purpose: pacote's filter, and archives npm
   extracts that pnpm itself cannot read.

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
   it. The decoders of a tar header's text, of a pax body and of a zip entry
   name now keep it (`ignoreBOM: true`; `tar-fields.test.ts`, `pax.test.ts`,
   `zip-names.test.ts`, the oracle's BOM cases), and so does the tar checksum
   field's, for consistency: its `trim()` removes a U+FEFF anyway, so no test
   can tell that one apart. Before, opm read `<U+FEFF>package/x.js` as
   `package/x.js`.

   **The classes refused in npm mode**, each with its oracle cases (the cases
   the two read differently are refused; the over-refusals follow the classes):
   - **The end, `TAR_AMBIGUOUS_END`.** pnpm stops at the first header position
     whose first byte is 0 and reads a header past the end of the data (and
     fails). node-tar ends at two null blocks in a row or at the end of the
     data, and skips a lone null block and a block whose checksum fails. opm
     refuses a lone zero block followed by an entry, a zero block before the
     first entry, data that ends with no zero block, a header whose name starts
     with NUL with its path in the prefix, and an archive that ends before its
     first header (two zero blocks first): `Parse` and pnpm read no file from
     it, and npm's `tar.x` fails ("Unrecognized archive format",
     `TAR_BAD_ARCHIVE`). The decision is one pass over the rest of the archive
     with node-tar's checksum reading and null-block rule, made once, at the
     first zero byte in header position. It assumes node-tar is at the same
     offset as opm. The checksum, directory, number, link-name, text and type
     classes below refuse the headers found after which it would not be; the
     fuzz families under Consequences found no other, and cannot show there is
     none.
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
     refused: a NUL and then digits (pnpm skips the NUL and reads the digits,
     the 12th byte included; node-tar and opm read 0, and node-tar reads the
     body as headers), a line feed or a tab and then a space and digits
     (node-tar and opm read the number; pnpm fails). The mode field is read by
     the same three functions, and pnpm installs a file executable when the mode
     it reads has an execute bit (`modeIsExecutable`) where node-tar and `tar.x`
     take the bits of theirs: a NUL then `000755` gives pnpm an executable and
     npm and opm a plain file, and a line feed or a tab, a space and `00755` the
     reverse. A mode they do not read as one number is refused the same way.
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
     it read the rest as headers. A record whose key starts with a line feed is
     the same case: node-tar splits there and reads the record behind it. (3) A
     header of more than one block (over 512 bytes) with a byte past 0x7f from
     body offset 511 on: node-tar decodes an `x` or `g` body piece by piece as
     it is fed (`this[META] += chunk`), the first piece of a body is a whole
     block or more, and a body of one block is always delivered whole, so the
     first character a cut can split is one whose first byte is at offset 511
     (the sixth review swept offsets 495 to 1,300 against 20 piece sizes). A
     character cut in two becomes two U+FFFD and its record is ignored, so
     node-tar's answer depends on how the archive reached it (a decompressor's
     output chunk, a network read, a file read), where pnpm and opm read the
     record. A character before offset 511 is accepted:
     `acorn-object-spread@1.0.0` has pax bodies of 978 to 981 bytes with one at
     offsets 364 and 365, which every reader reads alike (the oracle holds its
     shape). The bound is one byte conservative: a character ending at offset
     511 is refused although no cut reaches it. The oracle holds nine archives
     of this kind; three read differently in pieces (a two-byte and a three-byte
     character across offset 512 of the body, the latter's first byte at 510, in
     pieces of 1 byte; a character across offset 16,384, in pieces of 1 and of
     16,384), on both node-tar lines. (4) A length prefix with a leading zero
     (`0023 path=package/X.js`) and a record whose last byte is not a newline
     are malformed (`INVALID_PAX_HEADER`): node-tar ignores the record, pnpm
     applies it. (5) A `linkpath` record, in an `x` or a `g`: `tar.x` acts on it
     for every entry, files included, where `Parse`, pnpm and opm ignore it on a
     file. node-tar 6.2.1 turns an all-digit value into a number and throws
     `s.normalize is not a function` from inside the extraction; node-tar 7.5.22
     drops the file when the value resolves outside the directory (`..`), so npm
     11 omits a file that npm 10, pnpm and opm install. The rule refuses none of
     the registry sample under Consequences.
   - **A type, `TAR_AMBIGUOUS_TYPE`.** Typeflag `7` (a contiguous file) is
     extracted by node-tar and opm; pnpm throws "Unsupported file type 55".
   - **A path, `TAR_AMBIGUOUS_PATH`.** A file whose path has a backslash:
     node-tar keeps it in the name, or drops a single-component path; pnpm trims
     the first component at it; opm reads it as a separator, so the file lands
     at a path no other reader uses. A file whose path has no slash: node-tar's
     strip drops it, pnpm installs it.

   **The spelling layer, `TAR_AMBIGUOUS_SPELLING`** (`tar-spelling.ts`, called
   after the checks above, so a header they refuse keeps their code). Five
   rounds of review each found a new spelling of a numeric field that node-tar
   (`decSmallNumber`, `decNumber`), pnpm (`parseOctal`) and opm (`tarNumber`)
   read as different numbers: a list of known differences had not converged. So
   each field also has a class of spellings, taken from the sixth review's
   histogram of 98,074 headers in 3,386 registry archives (two to four spellings
   per field), every one of which the three read as one number; any other
   spelling is refused.

   | Field                   | Accepted spellings                                                                                                                                      | Why this class                                                                                                                                                                                                          |
   | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | mode, size              | octal digits, led by spaces at most, ended by at most one space, then NULs; or all NUL                                                                  | the spellings real writers use (`0000644\0`, `000644 \0`, `00000000004 `); a NUL or a control character before the digits, or a byte after the NULs, is where the decoders part; base-256 is `ADAPTER_REQUIRED` already |
   | uid, gid, mtime         | the same, or base-256 led by 0x80 or 0xff                                                                                                               | node-tar writes base-256 where a number does not fit, and decodes it; no reader acts on these fields' values (`preserveOwner: false`, `noMtime`)                                                                        |
   | checksum                | six digits, a NUL and a space; or the octal class                                                                                                       | ustar's own spelling and the 7-digit and space-NUL forms in the registry                                                                                                                                                |
   | magic, version          | `ustar\0` `00`, `ustar  \0` (GNU) or eight NULs (V7)                                                                                                    | the magic decides whether node-tar reads the prefix and the numbers after it; any other value makes that decision ambiguous                                                                                             |
   | devmajor, devminor      | the number class with base-256, read under `ustar\0` `00` only                                                                                          | node-tar decodes them only there                                                                                                                                                                                        |
   | atime, ctime            | the number class with base-256, read under `ustar\0` `00` when byte 475 is zero                                                                         | where node-tar decodes them; otherwise bytes 345 to 499 are the prefix                                                                                                                                                  |
   | bytes 500 to 511        | all NUL                                                                                                                                                 | no reader uses them; writers zero them                                                                                                                                                                                  |
   | name, link name, prefix | no byte after the first NUL (the text class above)                                                                                                      | node-tar keeps text after a NUL and a line terminator                                                                                                                                                                   |
   | typeflag                | NUL, `0`, `5`, `x`, `g` are read; links, devices and FIFOs are refused, `7` is `TAR_AMBIGUOUS_TYPE` and every other type `ADAPTER_REQUIRED` (unchanged) | NUL is a regular file to all three readers, and a real package uses it (`@pnpm/resolving.jsr-specifier-parser`)                                                                                                         |
   | uname, gname            | anything                                                                                                                                                | no reader reads them for a path, a mode or content                                                                                                                                                                      |

   The layer reads single fields. What depends on more than one header or on the
   input's cutting (the end of the archive, a pending extended header, a dropped
   entry, the pieces a pax body arrives in) stays a rule above. On the registry
   sample under Consequences it refuses no archive.

   **Refused although the readers agree (accepted over-refusals, each an oracle
   case in `OVER_REFUSED`).** opm cannot tell, without re-implementing
   node-tar's whole header acceptance, that what it refuses yields no file: a
   zero block in header position followed by a header node-tar reads but that
   yields no file (one with no path, a directory, a base-256 checksum it cannot
   decode: `TAR_AMBIGUOUS_END`); a directory header node-tar drops for its
   checksum reading or an unreadable number, and a sized directory whose span
   holds nothing; an extended header with a size equal to its entry's, then a
   global header, and an extended header's path, a global header, then a
   directory; a directory with a link name that no extended header precedes; a
   link name on a global header, which node-tar drops; a newline in a pax record
   that changes nothing (a comment's value, a key); a prefix without `ustar\0`
   `00` magic that a pax path overrides; a backslash below the top-level
   directory; bytes after the first NUL of a name that hold no line terminator;
   a character ending at body offset 511 of a pax header over one block; and six
   headers the readers happen to read alike that the spelling layer refuses (a
   byte after the NUL of a mode or a uid, a letter after an mtime's digits, a
   devmajor of letters under ustar magic, magic `ustar` with the version `0 `,
   bytes in the last 12). On the registry sample under Consequences, none of the
   classes above and none of these over-refusals refuses an archive; npm mode
   refuses 6 of the 3,381 read, each for a reason this section gives or outside
   it (2 with no end block, below; 1 GNU long name, `ADAPTER_REQUIRED`; 1 over
   the compression ratio; 1 that is not gzip; 1 with an alternate data stream
   name).

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
   compares) and `pacote` and `pacote7` (what `tar.x` of each line writes with
   that filter, to a directory, or how it fails). `tar-end.test.ts` counts an
   archive whose `tar.x` fails or writes something else than its `Parse` reads
   as read differently, but for three ignore-file cases it lists (and a trailing
   slash that the file system drops); three of the 117 fail in `tar.x` (the two
   empty archives, `TAR_BAD_ARCHIVE` on both lines, and the numeric `linkpath`
   on 6.2.1), and all three are refused. The filter works on names and types
   after node-tar has read the header, so it cannot turn a disagreement about
   which entries exist into an agreement or back, and it leaves the contents
   alone. What it can change is the name of an inert ignore file, for every
   tarball however it is read: with a `.gitignore`, npm writes `.npmignore`
   where pnpm and opm write `.gitignore`. That is not a disagreement about how
   the tar is read, so it is not refused and not modelled in opm.

   **node-tar 7 (npm 11).** node-tar 7.5.22 reads 116 of the 117 oracle archives
   as 6.2.1 does, whole, in pieces and as `tar.x`, file for file (it warns less:
   a global header with a link name is one 6.2.1 drops with a warning and 7.x
   keeps, and neither reads a file from it). The other, an extended header with
   a link name and then a file, is one 6.2.1 drops ("linkpath forbidden") and
   7.x keeps (it exempts `x` and `g` from that rule); opm refuses it for 6.2.1's
   reason. 7.5.22's `tar.x` drops a file whose pax `linkpath` leaves the
   directory, which is why that record is refused. The claim about npm is a
   claim about these two lines. npm 10.9.4 also carries node-tar 7.4.3, under
   `cacache`; pacote 19.0.1 depends on `tar` `^6.1.11` and extracts with the
   top-level 6.2.1.

   **Limits, not decided here.** `@sentry/react-native@8.31.0` names files with
   GNU long-name headers (type `L`), which npm and pnpm both read and opm
   refuses in both modes, before this ADR (`ADAPTER_REQUIRED` in npm mode; under
   the general rule's defaults its `././@LongLink` name is refused first,
   `PATH_TRAVERSAL`). On Node 21, outside the `engines` range
   (`^22.19.0 || >=24`), three gzip tests fail: `node:zlib` has no `crc32`
   there.

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
  count, an abort at each of its checks); `tar-end.test.ts` (against the 117
  archives of `test/tar-oracle/oracle.json`: with `requireNpmReaderAgreement`,
  opm refuses the 63 on which the readers read different files or execute bits
  (node-tar 6.2.1 or 7.5.22 whole, in pieces or as `tar.x`, against pnpm), with
  the code `tar-end.expect.ts` lists, and the 22 listed over-refusals
  (`OVER_REFUSED`, each a case where they agree), and extracts node-tar's files
  and execute bits on the rest but for the one pinned layout difference
  (`PINNED`); without the option, a tar with no end block, one with a sized
  directory, an 8-digit checksum and a prefix without magic extract under the
  general rule, a lone zero block that data follows is refused, and any length
  of zero padding after the end is accepted); `tar-text.test.ts` (a byte after
  the first NUL of a name, a link name and a prefix, with the prefix's 130 and
  155 bytes and its magic); `tar-octal.test.ts` (opm's, pnpm's and node-tar's
  readers of a size and a mode field, row by row, and the spellings refused);
  `tar-spelling.test.ts` (each field's spelling class: the registry's spellings
  accepted, others refused, base-256 where node-tar writes it, the magic and
  byte 475 conditions); `tar-pax-agreement.test.ts` (a newline in a record, a
  `linkpath` record and records that only look like one, and a body over one
  block with a character at offsets 364, 509, 510, 511, 512 and on);
  `pax.test.ts` (malformed records, among them a length with a leading zero and
  a record with no final newline, and a byte order mark in a key);
  `tar-numbers.test.ts` (which fields node-tar decodes, under what magic, and
  which base-256 numbers it reads, at the safe-integer bound, positive and
  negative, in 8 and 12 bytes); `tar-fields.test.ts` (a name or prefix that is
  not UTF-8 is `INVALID_TAR_TEXT`, not a bare `TypeError`; a leading byte order
  mark is kept); `zip-names.test.ts` (a zip entry name with the UTF-8 flag set
  that is not UTF-8 is `INVALID_ZIP_NAME`, not a bare `TypeError`; a leading
  byte order mark is kept); `tar-fuzz.test.ts` (the fuzz below, every family at
  300 archives with a fixed seed, when the readers are installed); in
  `packages/opm-project/test/`, `frozen-install.gzip-padding.test.ts` (an
  install, the refusal by package and offset, the lock's integrity over the
  padding), `frozen-install.tar-agreement.test.ts` (a pnpm lock's archive with
  no end block is refused under its name), `install-limits.test.ts` (the option
  for npm and for no other ecosystem) and `shared-store.limits.test.ts` (tsc
  over a fixture: a shared-store call without `limits` does not compile); in
  `packages/adapter-npm`, both lock readers' `extraction` and
  `layout-write.wrapper.test.ts` (which directory of an extracted tarball is the
  package: a directory entry with no file beside `package/` is not a second
  wrapper; a file, or a second directory holding a file at any depth, keeps the
  store root); and in `apps/openpacker-cli/test/install-prefix.test.ts` (an npm
  artifact is extracted under the agreement and refused with its code; any other
  artifact under the general rule).
- The differential fuzz in the repository, `packages/materializer/test/tar-fuzz`
  (`run.mjs`; the families in `families.mjs` and `families-more.mjs`; its README
  says where each reader comes from and how to run it). It reads each archive
  with node-tar 6.2.1 and 7.5.22 (each asserted at its version when loaded;
  `fetch-node-tar-7.mjs` fetches 7.5.22 and checks it against pinned sha512s),
  each fed whole and in pieces of 1, 1,460, 16,384 and 65,536 bytes; with pnpm
  10.28.0's `parseTarball` (in a worker, under a 3-second deadline, because it
  spins on an `x` header whose size runs past the data); with opm in npm mode;
  and, with `--pacote`, with `tar.x` of each node-tar line under pacote's
  filter, on what opm extracts. A reading is the files, their content and their
  execute bits. It fails (exit 1) on an archive the readers read differently
  that opm extracts (`UNSAFE-ACCEPTED`), one they read alike that opm extracts
  as another set (`UNSAFE-SET`), and one opm extracts that a `tar.x` fails on or
  writes otherwise (`UNSAFE-TARX`); an archive pnpm misses its deadline on, or
  node-tar never ends, is counted as `inconclusive`, apart.
  `src/tar-fuzz.test.ts` runs every family at 300 archives, seed 20261024, in
  the materializer's suite when the readers are installed. Run on 2026-10-24,
  Node 22.22.0, with both node-tar lines and `--pacote`, on the code of this ADR
  and on `729efbb` (the code the sixth review read), each family's fixed list
  where it has one and 5,000 archives at seed 20261024; no archive was
  inconclusive:

  | Family        | What it builds                                                                                                                                                                                                                                                                   | Archives (fixed + seeded) | Failures on this code | Failures on `729efbb` |
  | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | --------------------- | --------------------- |
  | `byte-sweep`  | every header byte but the checksum's set to each of 15 values (NUL, LF, CR, space, `0`, `1`, `7`, `8`, `+`, `-`, `/`, backslash, 0x80, 0xef, 0xff), in five archives (a file whose body is an entry, a plain file, an executable file, a file with a ustar prefix, a pax header) | 37,800 + 5,000            | 0                     | 1 (fixed)             |
  | `field-bytes` | 1 to 3 runs of 1 to 4 bytes in the text and number fields of six bases (the five above and a directory), the checksum right or written one of seven ways                                                                                                                         | 5,000                     | 0                     | 1                     |
  | `pax-records` | 1 to 4 pax records from 15 shapes (newline in a path, a record inside a record, a length with a leading zero or off by one, no final newline, an empty path, a byte order mark in a key, comments of up to 1,300 bytes, with and without a byte past 0x7f), then a file          | 5,000                     | 0                     | 0                     |
  | `pax-cut`     | a path with a two-byte character, after padding swept across every offset around 2,048, 2,560, 2,920, 4,380, 16,384 and 32,768; seeded, the cut, padding and character drawn                                                                                                     | 246 + 5,000               | 0                     | 0                     |
  | `meta-order`  | every pair and every triple of 16 meta headers and files; seeded, runs of 2 to 5                                                                                                                                                                                                 | 4,864 + 5,000             | 0                     | 0                     |
  | `zero-blocks` | zero and null blocks between entries and after them, partial blocks of three kinds at 17 lengths, a pair of files cut every 37 bytes; seeded, runs of entries and blocks                                                                                                         | 1,183 + 5,000             | 0                     | 192 + 1,250           |

  On `729efbb` the two in `byte-sweep` and `field-bytes` are executable files
  whose mode field starts with a NUL: pnpm skips it and installs the file
  executable, node-tar reads no mode and does not (the mode rule). The 1,442 in
  `zero-blocks` begin with a zero or a null block, or are zeros only, and no
  reader reads a file from them: `729efbb` extracted nothing, `tar.x` fails
  (`TAR_BAD_ARCHIVE`), and this code refuses each (`TAR_AMBIGUOUS_END`). The
  `linkpath` rule and the bound at body offset 511 came from the sixth review,
  not from these families. That review's own sweep of 75,600 archives (each
  header byte but the checksum's, of the first two headers of five bases, set to
  the 15 values above), re-run on this code with each node-tar line: 13,320 are
  extracted as every reader reads them, 62,280 are refused, and none is
  extracted otherwise. What the families vary is what the table says and nothing
  more: no compressed members, sparse files or GNU long names
  (`ADAPTER_REQUIRED`), no header with more than a few fields changed, and none
  of them reaches every archive. A run with no failure is not a proof that there
  is none. Earlier rounds ran other generators and seeds (103,970, then 46,864
  archives, then seed 1 of these families on `bf75b25`); their figures are not
  repeated, and what they found is in the oracle.

- The registry sample in the repository,
  `packages/materializer/test/registry-sample` (`manifest.txt`: 3,387 archives
  of 1,198 packages, how they were drawn in its header; `run.mjs` reads each in
  memory; its README says how to run it). Run on 2026-10-24, Node 22.22.0, on
  the code of this ADR, on `729efbb` (the code the sixth review read) and on
  `59f001e` (the stack's base, before this ADR); 6 versions are no longer
  served, 3,381 were read. In npm mode this code extracts 3,375 and refuses the
  6 the over-refusals paragraph above lists; `729efbb` refused one more,
  `acorn-object-spread@1.0.0` (`TAR_AMBIGUOUS_PAX`: a character at offsets 364
  and 365 of a pax body, now accepted because no cut can reach it). The spelling
  layer, the mode rule, the `linkpath` rule and the empty-archive rule refuse
  none of the 3,381. The base has no npm mode. Under the general rule this code
  extracts 3,373: 9 archives whose gzip stream ends in zero padding
  (`block-stream@0.0.3`, `format@0.1.4`, `hash@0.1.0` and `0.2.0`,
  `require-directory@0.0.1`, `utile@0.0.1`, `uuid-v4.js@1.0.0` and `1.0.2`,
  `xml-stream@0.3.4`), which the base refused as `INVALID_COMPRESSION`, now
  extract, and no other archive is decided differently by any of the three
  builds; the 8 refused (5 `PATH_TRAVERSAL`, the `./` names the general defaults
  refuse; 1 over the ratio; 1 that is not gzip; 1 alternate data stream name)
  are refused by all three. Earlier rounds read other samples (475 and 386
  archives, the latter with 54 padded streams) with scripts that are not in the
  repository; their figures are not repeated here.
- Mutation runs, `packages/materializer/test/mutants` (`mutants.jsonl`,
  `run.mjs`, the run in `results.tsv`, its README): 129 mutants of the gzip
  decoder and of the rules of §8, the sixth review's 16 among them, each one
  edit run against the package's suite. 122 are killed; the other 7 are
  equivalent, each with its reason in the README.
- A package whose archive hides bytes behind its padding installs with npm and
  pnpm and is refused by opm. If one turns up, the refusal names it and the
  offset; accepting it would be a new decision, not a bug fix.
