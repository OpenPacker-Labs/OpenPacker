/**
 * Gzip members built byte by byte for the decoder's tests (RFC 1952), so a
 * test can set each optional header field, and damage a member where it wants.
 */

import { crc32, deflateRawSync } from 'node:zlib';
import { gunzipArchive } from './gzip.js';

export const text = (value: string) => new TextEncoder().encode(value);
export const concat = (...parts: Uint8Array[]) =>
  new Uint8Array(Buffer.concat(parts));
/** `value` as `bytes` little-endian bytes, as gzip writes its numbers. */
export const le = (value: number, bytes: number) =>
  Uint8Array.from(
    { length: bytes },
    (_, index) => (value >>> (8 * index)) & 0xff,
  );

export const FHCRC = 0x02;
export const FEXTRA = 0x04;
export const FNAME = 0x08;
export const FCOMMENT = 0x10;

/** The header of a member: the fixed ten bytes, then the fields `flags` names. */
export function memberHeader(flags: number): Uint8Array {
  const parts = [Uint8Array.of(0x1f, 0x8b, 8, flags, 0, 0, 0, 0, 0, 3)];
  if ((flags & FEXTRA) !== 0) parts.push(le(3, 2), text('xyz'));
  if ((flags & FNAME) !== 0) parts.push(text('name.tar'), Uint8Array.of(0));
  if ((flags & FCOMMENT) !== 0) parts.push(text('a comment'), Uint8Array.of(0));
  if ((flags & FHCRC) !== 0)
    parts.push(le(crc32(concat(...parts)) & 0xffff, 2));
  return concat(...parts);
}

/** A whole member: header, deflate data, CRC-32 and length of `content`. */
export function member(content: Uint8Array, flags = 0): Uint8Array {
  return concat(
    memberHeader(flags),
    deflateRawSync(content),
    le(crc32(content), 4),
    le(content.byteLength, 4),
  );
}

export type Outcome =
  | { accepted: true; output: string; end: number }
  | { accepted: false; code?: string | undefined; message: string };

/** What `gunzipArchive` makes of `bytes`, as data. */
export async function ours(
  bytes: Uint8Array,
  maximumBytes = 1 << 20,
  signal?: AbortSignal,
): Promise<Outcome> {
  return gunzipArchive(bytes, maximumBytes, signal).then(
    ({ expanded, streamEnd }) => ({
      accepted: true as const,
      output: Buffer.from(expanded).toString('hex'),
      end: streamEnd,
    }),
    (error: Error & { code?: string }) => ({
      accepted: false as const,
      code: error.code,
      message: error.message,
    }),
  );
}
