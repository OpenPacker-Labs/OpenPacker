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

/**
 * Where the next header is, from `offset`, or undefined where the archive
 * ends. With `npmReaders`, only where npm and pnpm agree (`endsHere`).
 * Otherwise the general rule, node-tar's and GNU tar's: two zero blocks in a
 * row or the end of the data end it, and a lone zero block is skipped.
 */
export function nextHeader(
  bytes: Uint8Array,
  offset: number,
  npmReaders: boolean,
): number | undefined {
  if (npmReaders) return endsHere(bytes, offset) ? undefined : offset;
  const zero = (at: number) =>
    bytes.subarray(at, at + BLOCK).every((byte) => byte === 0);
  if (offset + BLOCK > bytes.byteLength) return undefined;
  if (!zero(offset)) return offset;
  if (zero(offset + BLOCK)) return undefined;
  return offset + 2 * BLOCK <= bytes.byteLength ? offset + BLOCK : undefined;
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

/** Refuse a checksum field that node-tar reads as another number than opm. */
export function assertChecksumAgrees(header: Uint8Array, at: number): void {
  if (nodeTarChecksum(header) !== headerSum(header))
    throw unsafe(
      'TAR_AMBIGUOUS_CHECKSUM',
      `the header at offset ${at} has a checksum field npm reads over 12 bytes as another number: npm skips the entry, pnpm reads it`,
    );
}

/** Refuse a prefix that node-tar ignores: one without `ustar\0` `00` magic. */
export function assertPrefixAgrees(
  header: Uint8Array,
  prefix: string,
  at: number,
): void {
  if (prefix === '') return;
  const magic = header.subarray(257, 265);
  const ustar = [0x75, 0x73, 0x74, 0x61, 0x72, 0, 0x30, 0x30];
  if (!ustar.every((byte, index) => magic[index] === byte))
    throw unsafe(
      'TAR_AMBIGUOUS_PREFIX',
      `the header at offset ${at} has a prefix and no ustar magic: npm ignores the prefix, pnpm joins it to the name`,
    );
}
