# ADR 0057: A gzip stream may end in zero padding

- Status: Accepted
- Date: 2026-10-17
- Amends [ADR 0046](0046-a-lockfile-is-installed-not-re-resolved.md) §7 (what
  the materializer tolerates in an ecosystem's archives)
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
`DecompressionStream('gzip')`, which refuses any byte after the stream. npm
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
5. **Where zlib itself refuses**, the refusal still names an offset: the members
   are walked as zlib read them (RFC 1952 headers, the end of each member's
   deflate data found by inflating it), and the first byte that is neither a
   member's header nor zero is `GZIP_TRAILING_DATA`; a member that does not
   decode is `INVALID_COMPRESSION` "in the gzip member at offset N". The walk
   only words a refusal: what is accepted is decided by zlib and the zero scan,
   never by it. It stops after 1,024 members and is held to the same output
   budget.
6. **Nothing hashed changes, and the hash comes first.** The archive's integrity
   is checked over every byte, padding included, before it is decoded (the
   materializer's digest, and the sha512 a lock pins); changing one padding byte
   is `DIGEST_MISMATCH`. The padding counts toward `maximumCompressedBytes`, and
   the scan reads only bytes already held within it.
7. **Padding buys no expansion.** The compression ratio is measured against the
   gzip stream alone, without the padding, so zeros appended to a small stream
   do not raise how far it may expand.

## Consequences

- OpenSesame's lock installs whole, `tests/redteam` and `sylvester@0.0.21`
  included. Measured 2026-10-17 on linux-x64, Node 22.22.0, a 4-CPU VM under
  other agents' load (load average 50 to 57): `git archive` of OpenSesame
  `44a81f2de` and an empty store, both on tmpfs, `opm ci` with no `--filter`
  exits 0 in 741 s: 2,847 places from 1,739 archives fetched (639.1 MB), 4
  packages patched by 4 patches, 47 of 71 members linked, 193 optional packages
  for other platforms left out. `node_modules/sylvester` holds the archive's 20
  files and loads (`Matrix.create([[1,2],[3,4]]).determinant()` is `-2`).
- Tests: `packages/materializer/src/gzip-padding.test.ts` (padding, junk, junk
  behind padding, a member behind padding, two members, a damaged member, the
  size bound, the ratio, the digest), `src/gzip.test.ts` (400 seeded cases
  against `zlib.gunzipSync`: opm accepts exactly what Node accepts with only
  zeros after what Node read, with the same output; every refusal that names a
  byte names a non-zero one; the walk's bound; abort), and
  `packages/opm-project/test/frozen-install.gzip-padding.test.ts` (an install,
  the refusal by package and offset, the lock's integrity over the padding).
- A package whose archive hides bytes behind its padding installs with npm and
  pnpm and is refused by opm. If one turns up, the refusal names it and the
  offset; accepting it would be a new decision, not a bug fix.
