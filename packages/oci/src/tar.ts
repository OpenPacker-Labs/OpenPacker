/**
 * Minimal ustar writer for packing an OCI image layout into one artifact.
 *
 * Only regular files are supported — enough for `oci-layout`, `index.json`,
 * and `blobs/sha256/<hex>`. No external tar dependency: the layout is small
 * numbers of files and must be bit-stable for digest verification.
 */

const BLOCK = 512;
const encoder = new TextEncoder();

function pad(size: number): number {
  return (BLOCK - (size % BLOCK)) % BLOCK;
}

function octal(value: number, width: number): string {
  const body = value.toString(8);
  if (body.length > width - 1)
    throw new RangeError(`ustar field overflow: ${value} needs ${width}`);
  return body.padStart(width - 1, '0') + '\0';
}

function checksum(header: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < header.length; i += 1) sum += header[i]!;
  return sum;
}

function writeHeader(name: string, size: number, typeflag: string): Uint8Array {
  if (name.length > 100) throw new RangeError(`ustar name too long: ${name}`);
  const header = new Uint8Array(BLOCK);
  const put = (offset: number, text: string) => {
    const bytes = encoder.encode(text);
    header.set(bytes.subarray(0, Math.min(bytes.length, 100)), offset);
  };
  put(0, name);
  put(100, octal(0o644, 8)); // mode
  put(108, octal(0, 8)); // uid
  put(116, octal(0, 8)); // gid
  put(124, octal(size, 12));
  put(136, octal(Math.floor(Date.UTC(2026, 0, 1) / 1000), 12)); // mtime
  // checksum field filled with spaces while computing
  for (let i = 148; i < 156; i += 1) header[i] = 0x20;
  header[156] = typeflag.charCodeAt(0);
  put(257, 'ustar\0');
  put(263, '00');
  const sum = checksum(header);
  put(148, octal(sum, 8));
  // GNU/ustar checksum is six octal digits, NUL, space — octal() already
  // ends with NUL; put a space in the final checksum slot.
  header[155] = 0x20;
  return header;
}

export interface TarFile {
  /** Path inside the archive using `/` separators, no leading slash. */
  path: string;
  body: Uint8Array;
}

export interface AsyncTarFile {
  path: string;
  size: number;
  body: () => Promise<Uint8Array>;
}

function safeTarPath(input: string): string {
  const path = input.replace(/^\/+/u, '').replaceAll('\\', '/');
  if (path.includes('..') || path.startsWith('/'))
    throw new RangeError(`refusing unsafe tar path: ${input}`);
  return path;
}

/** Pack files into an uncompressed ustar archive. */
export function packUstar(files: readonly TarFile[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  for (const file of sorted) {
    const path = safeTarPath(file.path);
    parts.push(writeHeader(path, file.body.byteLength, '0'));
    parts.push(file.body);
    const padding = pad(file.body.byteLength);
    if (padding > 0) parts.push(new Uint8Array(padding));
  }
  // Two zero blocks end the archive.
  parts.push(new Uint8Array(BLOCK * 2));
  let total = 0;
  for (const part of parts) total += part.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/** Pack into one pre-sized archive while retaining at most one input body. */
export async function packUstarAsync(
  files: readonly AsyncTarFile[],
  maximumBytes: number,
): Promise<Uint8Array> {
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  let total = BLOCK * 2;
  for (const file of sorted) {
    if (!Number.isSafeInteger(file.size) || file.size < 0)
      throw new RangeError(`invalid ustar body size: ${file.size}`);
    total += BLOCK + file.size + pad(file.size);
    if (!Number.isSafeInteger(total) || total > maximumBytes)
      throw new RangeError(`ustar archive exceeds ${maximumBytes} bytes`);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const file of sorted) {
    const path = safeTarPath(file.path);
    out.set(writeHeader(path, file.size, '0'), offset);
    offset += BLOCK;
    const body = await file.body();
    if (body.byteLength !== file.size)
      throw new RangeError(
        `ustar body size changed for ${file.path}: expected ${file.size}, got ${body.byteLength}`,
      );
    out.set(body, offset);
    offset += file.size + pad(file.size);
  }
  return out;
}
