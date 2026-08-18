/**
 * Build the archives ecosystems actually publish.
 *
 * Compression is bought — `fflate` does gzip and zip, is dependency-free, and
 * is not something to reimplement. Tar *framing* is written here: it is a fixed
 * 512-byte record with a checksum, `tar-stream` would add four transitive
 * packages to a project that just tightened its own supply-chain policy, and
 * the materializer already owns a tar reader these bytes are round-tripped
 * through in the tests.
 */

import { gzipSync, zipSync } from 'fflate';

export interface ArchiveEntry {
  /** Path inside the archive, forward slashes, no leading `/` or `..`. */
  path: string;
  contents: Uint8Array;
  /** Unix mode; defaults to 0644, or 0755 when `executable`. */
  executable?: boolean;
}

const BLOCK = 512;

/**
 * A fixed timestamp so packing is reproducible.
 *
 * Zip stores a DOS date, which starts at 1980 and is interpreted in local
 * time — 1980-01-01Z falls out of range west of UTC, so this sits safely
 * inside the window instead of on its edge.
 */
const ZIP_EPOCH = new Date('1980-06-01T12:00:00Z');

/**
 * A gzipped tar, as npm publishes.
 *
 * Deterministic: no mtimes, no uid/gid, no gzip filename or timestamp field,
 * so the same inputs produce the same bytes and therefore the same digest.
 * That is the whole point of packing through PREX rather than through the
 * native tool.
 */
export function packTarGzip(entries: readonly ArchiveEntry[]): Uint8Array {
  return gzipSync(packTar(entries), { level: 9, mtime: 0 });
}

/** Deterministic uncompressed ustar, used for OCI layers and Debian members. */
export function packTar(entries: readonly ArchiveEntry[]): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const entry of sorted(entries)) {
    blocks.push(tarHeader(entry));
    blocks.push(entry.contents);
    const remainder = entry.contents.length % BLOCK;
    if (remainder !== 0) blocks.push(new Uint8Array(BLOCK - remainder));
  }
  // Two zero blocks terminate a tar, then padding to a 20-block record.
  blocks.push(new Uint8Array(BLOCK * 2));
  return concat(blocks);
}

/** A zip, as NuGet publishes (`.nupkg` is an OPC zip). */
export function packZip(entries: readonly ArchiveEntry[]): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  for (const entry of sorted(entries)) files[entry.path] = entry.contents;
  // A fixed timestamp for the same determinism reason as the tar above. Zip
  // cannot express 0 — its DOS date starts at 1980 — so that is the epoch used.
  return zipSync(files, { level: 9, mtime: ZIP_EPOCH });
}

/** Sorted by path so archive order never depends on caller order. */
function sorted(entries: readonly ArchiveEntry[]): ArchiveEntry[] {
  return [...entries].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
}

/**
 * A ustar header block.
 *
 * `prefix` is used when a path exceeds the 100-byte `name` field, which npm
 * packages routinely do; without it a deep path would be silently truncated
 * into a different file.
 */
function tarHeader(entry: ArchiveEntry): Uint8Array {
  const header = new Uint8Array(BLOCK);
  const { name, prefix } = splitPath(entry.path);

  writeString(header, 0, 100, name);
  writeOctal(header, 100, 8, entry.executable ? 0o755 : 0o644);
  writeOctal(header, 108, 8, 0); // uid
  writeOctal(header, 116, 8, 0); // gid
  writeOctal(header, 124, 12, entry.contents.length);
  writeOctal(header, 136, 12, 0); // mtime
  header.fill(0x20, 148, 156); // checksum field is spaces while summing
  header[156] = 0x30; // typeflag '0' — regular file
  writeString(header, 257, 6, 'ustar');
  header[263] = 0x30;
  header[264] = 0x30; // version "00"
  writeString(header, 265, 32, 'root');
  writeString(header, 297, 32, 'root');
  writeString(header, 345, 155, prefix);

  let sum = 0;
  for (const byte of header) sum += byte;
  // Six octal digits, NUL, space — the form every reader accepts.
  writeString(header, 148, 7, `${sum.toString(8).padStart(6, '0')}\0`);
  header[155] = 0x20;
  return header;
}

function splitPath(path: string): { name: string; prefix: string } {
  const bytes = new TextEncoder().encode(path);
  if (bytes.length <= 100) return { name: path, prefix: '' };
  // Split on a `/` that leaves both halves within their fields.
  for (let index = path.length - 1; index >= 0; index -= 1) {
    if (path[index] !== '/') continue;
    const prefix = path.slice(0, index);
    const name = path.slice(index + 1);
    if (
      new TextEncoder().encode(name).length <= 100 &&
      new TextEncoder().encode(prefix).length <= 155
    )
      return { name, prefix };
  }
  throw new RangeError(
    `Path is too long for a ustar header and cannot be split: ${path}`,
  );
}

function writeString(
  target: Uint8Array,
  offset: number,
  length: number,
  value: string,
): void {
  const bytes = new TextEncoder().encode(value);
  if (bytes.length > length)
    throw new RangeError(`Value does not fit in ${length} bytes: ${value}`);
  target.set(bytes, offset);
}

function writeOctal(
  target: Uint8Array,
  offset: number,
  length: number,
  value: number,
): void {
  const text = `${value.toString(8).padStart(length - 1, '0')}\0`;
  writeString(target, offset, length, text);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
