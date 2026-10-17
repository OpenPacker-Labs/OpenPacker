# ADR 0057: A gzip stream may end in zero padding

- Status: Accepted
- Date: 2026-10-17
- Amends [ADR 0046](0046-a-lockfile-is-installed-not-re-resolved.md) §7 (what
  the materializer tolerates in an ecosystem's archives: zero padding after the
  gzip stream, and, §8 below, a lone zero block inside the tar)
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
8. **A lone zero block inside the tar does not end it.** Found by the same
   review. The tar reader stopped at the first all-zero block, so an entry after
   one lone zero block was dropped, silently, where npm's node-tar extracts it.
   It now ends an archive as node-tar 6.2.1 does: at two zero blocks in a row,
   or at the end of the data. A lone zero block is skipped, and the next block
   is read as a header: it counts toward `maximumFiles`, and a block that is not
   a header is refused (node-tar warns `TAR_ENTRY_INVALID`, skips it, and reads
   on). Nothing after two zero blocks is read, as before. pnpm 10.28.0's
   `parseTarball` stops at any block whose first byte is zero, so it extracts
   less than npm from these archives; opm follows npm, which extracts more,
   rather than drop what npm installs. The oracle is
   `packages/materializer/test/tar-oracle/` (node-tar and pnpm over the same 10
   archives).

## Consequences

- OpenSesame's lock installs whole, `tests/redteam` and `sylvester@0.0.21`
  included. Measured 2026-10-17 on linux-x64, Node 22.22.0, a 4-CPU VM under
  other agents' load (load average 50 to 57): `git archive` of OpenSesame
  `44a81f2de` and an empty store, both on tmpfs, `opm ci` with no `--filter`
  exits 0 in 741 s: 2,847 places from 1,739 archives fetched (639.1 MB), 4
  packages patched by 4 patches, 47 of 71 members linked, 193 optional packages
  for other platforms left out. `node_modules/sylvester` holds the archive's 20
  files and loads (`Matrix.create([[1,2],[3,4]]).determinant()` is `-2`).
- Tests, in `packages/materializer/src/`: `gzip-padding.test.ts` (padding, junk,
  junk behind padding, a member behind padding, two members, a damaged member,
  the size bound, the ratio, the digest); `gzip.test.ts` (400 seeded cases
  against `zlib.gunzipSync`: opm accepts exactly what Node accepts with only
  zeros after what Node read, with the same output, and refuses the rest with
  the code each case was built for; the decoder's output bound at the bound, and
  refused as output arrives; abort); `gzip-walk.test.ts` (CRC-32, length and
  header CRC named at their member, each optional header field alone, a cut
  trailer, the walk's budget and member count, an abort at each of its checks);
  `tar-end.test.ts` (the tar's end against `test/tar-oracle/oracle.json`); and
  `packages/opm-project/test/frozen-install.gzip-padding.test.ts` (an install,
  the refusal by package and offset, the lock's integrity over the padding).
- A package whose archive hides bytes behind its padding installs with npm and
  pnpm and is refused by opm. If one turns up, the refusal names it and the
  offset; accepting it would be a new decision, not a bug fix.
