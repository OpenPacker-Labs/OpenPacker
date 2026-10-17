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
8. **opm refuses what the two reference extractors read differently.** Found by
   the same review. npm extracts with node-tar 6.2.1 and pnpm 10.28.0 with its
   own `parseTarball`; where the two would install different files from one
   archive, opm installs neither set and refuses the archive with a typed code,
   rather than choose a side. Where they agree, opm extracts what both extract.
   The cases, each in `packages/materializer/test/tar-oracle/` (both readers
   over the same bytes, 19 archives; `generate.mjs --check` re-runs them):
   - **The end, `TAR_AMBIGUOUS_END`.** pnpm stops at the first header position
     whose first byte is 0, and reads a header past the end of the data (and
     fails). node-tar ends at two null blocks in a row or at the end of the
     data, and skips a lone null block and a block whose checksum fails. So opm
     refuses: a lone zero block followed by an entry (npm installs it, pnpm does
     not), a zero block before the first entry, data that ends with no zero
     block (pnpm fails, npm installs), and a header whose name starts with NUL
     with its path in the prefix (pnpm stops there, npm installs it). A lone
     zero block followed only by blocks node-tar skips, or by a second zero
     block, ends the archive for both, and opm extracts what came before it;
     nothing after the end is read. The decision is one pass over the rest of
     the archive with node-tar's own checksum reading and null-block rule, made
     once, at the first zero byte in header position.
   - **The checksum, `TAR_AMBIGUOUS_CHECKSUM`.** node-tar reads the field over
     12 bytes, into the typeflag and the link name; pnpm and opm over its 8. An
     8-digit field with no terminator before a typeflag digit is another number
     to node-tar, which skips the entry; pnpm installs it.
   - **The prefix, `TAR_AMBIGUOUS_PREFIX`.** node-tar joins the prefix to the
     name only under `ustar\0` `00` magic; pnpm and opm always do. A prefix with
     any other magic (none, or GNU's `ustar  `) is refused.
   - **Blocks that are not all zero.** node-tar also takes for a null block one
     whose checksum field is not a number and whose other bytes are zero. Where
     such a block sits at pnpm's end, opm reads it as node-tar does, to decide
     whether the two agree. Anywhere pnpm reads a header, opm is stricter than
     node-tar: a block whose checksum fails is refused, where node-tar warns
     `TAR_ENTRY_INVALID`, skips it and reads on.

   This replaces the first answer to the review, which skipped a lone zero block
   and extracted the entries after it as npm does, and so installed, from a pnpm
   lock, files pnpm itself never installs. The rules apply to every tar the
   materializer reads, whatever the ecosystem: a refusal is the safe side of any
   disagreement. None of these shapes appears in the registry sample below, nor
   among the 1,739 archives of OpenSesame's lock; a tar from another ecosystem
   that ends with no zero block (pnpm's failure) is now refused too, which no
   test here has met.

## Consequences

- OpenSesame's lock installs whole, `tests/redteam` and `sylvester@0.0.21`
  included. Each run: linux-x64, Node 22.22.0, a 4-CPU VM under other agents'
  load, `git archive` of OpenSesame's main and an empty store, both on tmpfs,
  `opm ci` with no `--filter`; each exits 0 with 2,847 places from 1,739
  archives fetched (639.1 MB), 4 packages patched by 4 patches, 47 of 71 members
  linked, 193 optional packages for other platforms left out, and
  `node_modules/sylvester` holding the archive's 20 files and loading
  (`Matrix.create([[1,2],[3,4]]).determinant()` is `-2`):

  | Code                                         | OpenSesame  | Wall    | Load average |
  | -------------------------------------------- | ----------- | ------- | ------------ |
  | the padding fix (§1 to §7)                   | `44a81f2de` | 741 s   | 50 to 57     |
  | after the first review (lone zero skipped)   | `7afd8025b` | 936.5 s | about 44     |
  | after the second review (§8 as written here) | `034ff40d5` | 1,290 s | 39 to 45     |

- Tests, in `packages/materializer/src/`: `gzip-padding.test.ts` (padding, junk,
  junk behind padding, a member behind padding, two members, a damaged member,
  the size bound, the ratio, the digest); `gzip.test.ts` (400 seeded cases
  against `zlib.gunzipSync`: opm accepts exactly what Node accepts with only
  zeros after what Node read, with the same output, and refuses the rest with
  the code each case was built for; the decoder's output bound at the bound, and
  refused as output arrives; abort); `gzip-walk.test.ts` (CRC-32, length and
  header CRC named at their member, each optional header field alone, a cut
  trailer, the walk's budget, alone and as gunzipArchive sets it, its member
  count, an abort at each of its checks); `tar-end.test.ts` (against
  `test/tar-oracle/oracle.json`: opm refuses exactly the cases where npm and
  pnpm install different files, with the code, and extracts node-tar's set where
  they agree); and
  `packages/opm-project/test/frozen-install.gzip-padding.test.ts` (an install,
  the refusal by package and offset, the lock's integrity over the padding).
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
