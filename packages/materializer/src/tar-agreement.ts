/**
 * Where npm's and pnpm's tar readers would install different files from the
 * same archive, opm refuses it rather than choose one (ADR 0057 §8). npm reads
 * with node-tar 6.2.1, pnpm 10.28.0 with its own `parseTarball`, and opm with
 * the materializer's `parseTar`; each rule below is where they part.
 *
 * - The end. pnpm stops at the first header position whose first byte is 0, and
 *   reads a header past the end of the data (and fails). node-tar ends at two
 *   null blocks in a row or at the end of the data; it skips a lone null block
 *   and a block that fails its checksum, and reads on.
 * - The checksum. node-tar reads the field over 12 bytes (into the typeflag and
 *   the link name), pnpm and opm over its 8.
 * - The prefix. node-tar joins it to the name only under `ustar\0` `00` magic;
 *   pnpm and opm always do.
 */

import { unsafe } from './errors.js';
import { assertNumbersAgree } from './tar-numbers.js';

const BLOCK = 512;
const utf8 = new TextDecoder('utf-8');

/** The sum every reader checks: each byte, the checksum field read as spaces. */
export function headerSum(header: Uint8Array): number {
  let sum = 0;
  for (let index = 0; index < BLOCK; index += 1)
    sum += index >= 148 && index < 156 ? 32 : (header[index] ?? 0);
  return sum;
}

/**
 * node-tar's checksum (`decNumber(buf, 148, 12)`): 12 bytes cut at the first NUL,
 * trimmed, read in octal; not a number is null. A base-256 field is undefined:
 * this module does not read it, and treats it as a header node-tar may accept.
 */
export function nodeTarChecksum(header: Uint8Array): number | null | undefined {
  if (((header[148] ?? 0) & 0x80) !== 0) return undefined;
  const text = utf8
    .decode(header.subarray(148, 160))
    .replace(/\0.*$/u, '')
    .trim();
  const value = Number.parseInt(text, 8);
  return Number.isNaN(value) ? null : value;
}

/**
 * Whether node-tar would read a header from the block at `from` on, in header
 * position: it skips a lone null block and a block whose checksum fails, and
 * ends at two null blocks in a row or at the end of the data. One pass over
 * the rest of the archive, made once.
 */
function nodeTarReadsOn(bytes: Uint8Array, from: number): boolean {
  let sawNull = false;
  for (let at = from; at + BLOCK <= bytes.byteLength; at += BLOCK) {
    const block = bytes.subarray(at, at + BLOCK);
    const checksum = nodeTarChecksum(block);
    if (checksum === undefined) return true;
    const sum = headerSum(block);
    if (checksum === null && sum === 8 * 32) {
      if (sawNull) return false;
      sawNull = true;
      continue;
    }
    sawNull = false;
    if (checksum === sum) return true;
  }
  return false;
}

/** Whether the block at `at` is all zero; one cut short by the data's end counts for its length. */
function zeroBlock(bytes: Uint8Array, at: number): boolean {
  return bytes.subarray(at, at + BLOCK).every((byte) => byte === 0);
}

/**
 * Where the next header is, from `offset`, or undefined where the archive
 * ends. With `npmReaders`, only where npm and pnpm agree (`endsHere`).
 * Otherwise the general rule: the data's end, or two zero blocks in a row, end
 * it, and what follows them is not read. A lone zero block that anything but
 * zeros follows is refused: GNU tar 1.35 (a warning), Python's `tarfile` and
 * Go's `archive/tar` (an error) stop reading at it, node-tar reads on, so no
 * reading of it is safe.
 */
export function nextHeader(
  bytes: Uint8Array,
  offset: number,
  npmReaders: boolean,
): number | undefined {
  if (npmReaders) return endsHere(bytes, offset) ? undefined : offset;
  if (offset + BLOCK > bytes.byteLength) return undefined;
  if (!zeroBlock(bytes, offset)) return offset;
  if (zeroBlock(bytes, offset + BLOCK)) return undefined;
  throw unsafe(
    'TAR_AMBIGUOUS_END',
    `a lone zero block at offset ${offset} is followed by more data: GNU tar, Python's tarfile and Go's archive/tar stop there, node-tar reads on`,
  );
}

/**
 * Whether the archive ends at `offset`, a header position, where npm and pnpm
 * agree that it does; false where both read a header there. Anything else is
 * refused as TAR_AMBIGUOUS_END.
 */
function endsHere(bytes: Uint8Array, offset: number): boolean {
  if (bytes[offset] !== 0) {
    if (offset + BLOCK <= bytes.byteLength) return false;
    throw unsafe(
      'TAR_AMBIGUOUS_END',
      `the data ends at offset ${offset} with no zero block: pnpm reads a header past it and fails, npm ends there`,
    );
  }
  if (nodeTarReadsOn(bytes, offset))
    throw unsafe(
      'TAR_AMBIGUOUS_END',
      `pnpm ends the archive at the zero byte at offset ${offset}, and npm reads a header after it`,
    );
  return true;
}

/** Refuse a header field the readers read differently (ADR 0057 §8). */
export function assertHeaderAgrees(header: Uint8Array, at: number): void {
  assertChecksumAgrees(header, at);
  assertPrefixAgrees(header, at);
  assertNumbersAgree(header, at, hasUstarMagic(header));
  assertLinkNameAgrees(header, at);
}

/** node-tar reads the fields after the magic only under `ustar\0` `00`. */
function hasUstarMagic(header: Uint8Array): boolean {
  const magic = header.subarray(257, 265);
  return [0x75, 0x73, 0x74, 0x61, 0x72, 0, 0x30, 0x30].every(
    (byte, index) => magic[index] === byte,
  );
}

/** Refuse a checksum field that node-tar reads as another number than opm. */
function assertChecksumAgrees(header: Uint8Array, at: number): void {
  if (nodeTarChecksum(header) !== headerSum(header))
    throw unsafe(
      'TAR_AMBIGUOUS_CHECKSUM',
      `the header at offset ${at} has a checksum field npm reads over 12 bytes as another number: npm skips the entry, pnpm reads it`,
    );
}

/** Refuse a prefix that node-tar ignores: one without `ustar\0` `00` magic. */
function assertPrefixAgrees(header: Uint8Array, at: number): void {
  if (header[345] === 0 || hasUstarMagic(header)) return;
  throw unsafe(
    'TAR_AMBIGUOUS_PREFIX',
    `the header at offset ${at} has a prefix and no ustar magic: npm ignores the prefix, pnpm joins it to the name`,
  );
}

/**
 * Refuse a link name on a header that is no link. node-tar drops such an entry
 * (`TAR_ENTRY_INVALID`, "linkpath forbidden") and reads its data as headers;
 * pnpm and opm read it. A directory is dropped too, but has no data and no
 * file, so the file sets agree and it is not refused. Links themselves are
 * refused whatever their name.
 */
function assertLinkNameAgrees(header: Uint8Array, at: number): void {
  const type = String.fromCharCode(header[156] ?? 0);
  if (header[157] === 0 || ['1', '2', '5'].includes(type)) return;
  throw unsafe(
    'TAR_AMBIGUOUS_LINK',
    `the header at offset ${at} has a link name and is no link: npm drops the entry and reads its data as headers, pnpm reads the entry`,
  );
}

/**
 * Refuse a global header after an extended header whose path or size is still
 * to apply. pnpm applies them to the global header and the file keeps its own
 * name; node-tar and opm carry them across it to the file.
 */
export function assertGlobalAgrees(
  pending: ReadonlyMap<string, string> | undefined,
  at: number,
): void {
  if (pending?.has('path') !== true && pending?.has('size') !== true) return;
  throw unsafe(
    'TAR_AMBIGUOUS_PAX',
    `the global header at offset ${at} follows an extended header with a path or size: pnpm applies them to it, npm to the entry after it`,
  );
}

/**
 * Refuse an entry the readers see as a different kind, or skip a different
 * span for. `spelled` is its path as the archive writes it (a pax path, or the
 * prefix and the name). node-tar takes a directory's size for 0 and a file
 * named with a trailing slash for a directory; pnpm skips a directory's size
 * and installs the file; opm skips the size. A sized directory therefore
 * hides, from two of the three, the entries inside its span.
 */
export function assertEntryAgrees(
  type: string,
  size: number,
  spelled: string,
): void {
  if (type === '7')
    throw unsafe(
      'TAR_AMBIGUOUS_TYPE',
      `${spelled} is a contiguous file (typeflag 7): npm extracts it, pnpm throws "Unsupported file type"`,
    );
  const file = type === '0' || type === '\0';
  if (file && !spelled.endsWith('/')) assertPathAgrees(spelled);
  if (type === '5' ? size !== 0 : file && spelled.endsWith('/'))
    throw unsafe(
      'TAR_AMBIGUOUS_DIRECTORY',
      type === '5'
        ? `the directory ${spelled} has a size of ${size} bytes: npm takes it for 0, pnpm and opm skip that many bytes and read no entry inside them`
        : `${spelled} is a file named like a directory: npm makes a directory of it, pnpm installs a file`,
    );
}

/**
 * Refuse a file path the three readers place differently. node-tar strips the
 * first component whatever it is, and drops a path with only one; pnpm trims
 * the first component at a slash or a backslash and keeps a path with none; opm
 * reads a backslash as a separator. A name with a backslash is refused whether
 * or not npm and pnpm agree on it, as opm would install it elsewhere than both.
 */
function assertPathAgrees(spelled: string): void {
  if (spelled.includes('\\'))
    throw unsafe(
      'TAR_AMBIGUOUS_PATH',
      `${spelled} has a backslash: node-tar keeps it in the name, pnpm trims at it, opm reads it as a separator`,
    );
  if (!spelled.includes('/'))
    throw unsafe(
      'TAR_AMBIGUOUS_PATH',
      `${spelled} is a file with no directory above it: npm's strip drops it, pnpm installs it`,
    );
}
