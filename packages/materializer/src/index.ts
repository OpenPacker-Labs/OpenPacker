import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import {
  collectStream,
  streamFromBytes,
  type ArtifactSource,
} from '@openpacker/artifact-model';
import { compareCanonicalStrings, sha256 } from '@openpacker/canonical';
import type { ArtifactDescriptor, Digest } from '@openpacker/contracts';

export type ArchiveFormat = 'tar' | 'tar+gzip' | 'zip';

export interface MaterializationLimits {
  maximumFiles: number;
  maximumExpandedBytes: number;
  maximumCompressedBytes: number;
  maximumCompressionRatio: number;
  maximumPathBytes: number;
  maximumDepth: number;
}

export const DEFAULT_MATERIALIZATION_LIMITS: MaterializationLimits = {
  maximumFiles: 10_000,
  maximumExpandedBytes: 1024 * 1024 * 1024,
  maximumCompressedBytes: 512 * 1024 * 1024,
  maximumCompressionRatio: 100,
  maximumPathBytes: 4096,
  maximumDepth: 128,
};

export interface InspectedArchiveEntry {
  path: string;
  type: 'file' | 'directory';
  mode: number;
  data: Uint8Array;
}

export interface MaterializedFile {
  path: string;
  size: number;
  digest: Digest;
  mode: number;
}

export interface MaterializationManifest {
  manifestVersion: '1';
  artifactDigest: Digest;
  artifactSize: number;
  destination: string;
  files: MaterializedFile[];
  expandedSize: number;
  lifecycleScriptsExecuted: false;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });
const utf8Bytes = new TextEncoder();

export function validateArchivePath(
  input: string,
  limits: MaterializationLimits = DEFAULT_MATERIALIZATION_LIMITS,
): string {
  if (input.includes('\0')) throw unsafe('NUL_PATH', input);
  if (
    /^[a-zA-Z]:/u.test(input) ||
    input.startsWith('\\\\') ||
    input.startsWith('//')
  )
    throw unsafe('WINDOWS_ABSOLUTE_PATH', input);
  const value = input.replaceAll('\\', '/');
  if (value.startsWith('/')) throw unsafe('ABSOLUTE_PATH', input);
  const path = value.endsWith('/') ? value.slice(0, -1) : value;
  const parts = path.split('/');
  if (
    path === '' ||
    parts.some((part) => part === '' || part === '.' || part === '..')
  )
    throw unsafe('PATH_TRAVERSAL', input);
  if (parts.length > limits.maximumDepth)
    throw unsafe('PATH_DEPTH_LIMIT', input);
  if (utf8Bytes.encode(path).byteLength > limits.maximumPathBytes)
    throw unsafe('PATH_LENGTH_LIMIT', input);
  return parts.join('/');
}

export async function inspectArchive(
  bytes: Uint8Array,
  format: ArchiveFormat,
  limits: MaterializationLimits = DEFAULT_MATERIALIZATION_LIMITS,
  signal?: AbortSignal,
): Promise<InspectedArchiveEntry[]> {
  validateLimits(limits);
  if (bytes.byteLength > limits.maximumCompressedBytes)
    throw unsafe('COMPRESSED_SIZE_LIMIT', `${bytes.byteLength}`);
  const ratioLimit = Math.floor(
    bytes.byteLength * limits.maximumCompressionRatio,
  );
  const gzipLimit = Math.min(limits.maximumExpandedBytes, ratioLimit);
  const expanded =
    format === 'tar+gzip'
      ? await decompress(
          bytes,
          'gzip',
          gzipLimit,
          signal,
          gzipLimit < limits.maximumExpandedBytes
            ? 'COMPRESSION_RATIO_LIMIT'
            : 'EXPANDED_SIZE_LIMIT',
        )
      : bytes;
  if (format === 'tar+gzip')
    validateRatio(expanded.byteLength, bytes.byteLength, limits);
  const entries =
    format === 'zip'
      ? await parseZip(bytes, limits, signal)
      : parseTar(expanded, limits);
  validateEntries(entries, limits);
  return entries;
}

export async function materialize(input: {
  source: ArtifactSource;
  descriptor: ArtifactDescriptor;
  destination: string;
  format: ArchiveFormat;
  limits?: MaterializationLimits;
  signal?: AbortSignal;
  managedDestination?: boolean;
}): Promise<MaterializationManifest> {
  const limits = input.limits ?? DEFAULT_MATERIALIZATION_LIMITS;
  validateLimits(limits);
  input.signal?.throwIfAborted();
  if (await exists(input.destination)) {
    if (!input.managedDestination)
      throw new MaterializationError(
        'DESTINATION_EXISTS',
        'Destination already exists; materialization never merges or overwrites prefixes',
      );
    const stat = await lstat(input.destination);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw unsafe('UNSAFE_MANAGED_DESTINATION', input.destination);
    if ((await readdir(input.destination)).length > 0)
      throw new MaterializationError(
        'DESTINATION_EXISTS',
        'Managed destination must be empty before atomic materialization',
      );
    await rmdir(input.destination);
  }
  const parent = resolve(dirname(input.destination));
  await mkdir(parent, { recursive: true });
  const staging = await mkdtemp(
    join(parent, `.${basename(input.destination)}.openpacker-`),
  );
  try {
    const bytes = await verifiedDownload(
      input.source,
      input.descriptor,
      limits.maximumCompressedBytes,
      input.signal,
    );
    const entries = await inspectArchive(
      bytes,
      input.format,
      limits,
      input.signal,
    );
    const files: MaterializedFile[] = [];
    for (const entry of entries.filter(({ type }) => type === 'directory')) {
      input.signal?.throwIfAborted();
      await mkdir(join(staging, ...entry.path.split('/')), {
        recursive: true,
        mode: 0o755,
      });
    }
    for (const entry of entries.filter(({ type }) => type === 'file')) {
      input.signal?.throwIfAborted();
      const path = join(staging, ...entry.path.split('/'));
      await mkdir(dirname(path), { recursive: true, mode: 0o755 });
      await writeFile(path, entry.data, { flag: 'wx', mode: entry.mode });
      await chmod(path, entry.mode);
      files.push({
        path: entry.path,
        size: entry.data.byteLength,
        digest: await sha256(entry.data),
        mode: entry.mode,
      });
    }
    input.signal?.throwIfAborted();
    await rename(staging, input.destination);
    files.sort((left, right) => compareCanonicalStrings(left.path, right.path));
    return {
      manifestVersion: '1',
      artifactDigest: input.descriptor.digest,
      artifactSize: input.descriptor.size,
      destination: input.destination,
      files,
      expandedSize: files.reduce((sum, file) => sum + file.size, 0),
      lifecycleScriptsExecuted: false,
    };
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function verifiedDownload(
  source: ArtifactSource,
  descriptor: ArtifactDescriptor,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  await source.stat(descriptor, signal);
  if (descriptor.size > maximumBytes)
    throw unsafe('COMPRESSED_SIZE_LIMIT', `${descriptor.size}`);
  const reader = (await source.open(descriptor, undefined, signal)).getReader();
  const hash = createHash('sha256');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const item = await reader.read();
      if (item.done) break;
      if (!item.value) continue;
      size += item.value.byteLength;
      if (size > maximumBytes || size > descriptor.size)
        throw new MaterializationError(
          'SIZE_MISMATCH',
          'Artifact stream exceeded its declared or configured size',
        );
      hash.update(item.value);
      chunks.push(item.value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (size !== descriptor.size)
    throw new MaterializationError(
      'SIZE_MISMATCH',
      `Artifact stream has ${size} bytes, expected ${descriptor.size}`,
    );
  const digest = hash.digest('hex');
  if (digest !== descriptor.digest.value)
    throw new MaterializationError(
      'DIGEST_MISMATCH',
      `Artifact stream digest sha256:${digest} does not match descriptor`,
    );
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function parseTar(
  bytes: Uint8Array,
  limits: MaterializationLimits,
): InspectedArchiveEntry[] {
  const entries: InspectedArchiveEntry[] = [];
  let offset = 0;
  while (offset + 512 <= bytes.byteLength) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    verifyTarChecksum(header);
    const name = tarText(header.subarray(0, 100));
    const prefix = tarText(header.subarray(345, 500));
    const path = validateArchivePath(
      prefix ? `${prefix}/${name}` : name,
      limits,
    );
    const size = tarNumber(header.subarray(124, 136));
    const mode = tarNumber(header.subarray(100, 108));
    const type = String.fromCharCode(header[156] ?? 0);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (!Number.isSafeInteger(dataEnd) || dataEnd > bytes.byteLength)
      throw unsafe('TRUNCATED_ARCHIVE', path);
    if (type === '\0' || type === '0' || type === '7') {
      entries.push({
        path,
        type: 'file',
        mode: mode & 0o111 ? 0o755 : 0o644,
        data: bytes.slice(dataStart, dataEnd),
      });
    } else if (type === '5') {
      entries.push({
        path,
        type: 'directory',
        mode: 0o755,
        data: new Uint8Array(),
      });
    } else if (type === '1') {
      throw unsafe('HARDLINK_REJECTED', path);
    } else if (type === '2') {
      throw unsafe('SYMLINK_REJECTED', path);
    } else if (['3', '4', '6'].includes(type)) {
      throw unsafe('SPECIAL_FILE_REJECTED', path);
    } else {
      throw new MaterializationError(
        'ADAPTER_REQUIRED',
        `Unsupported tar entry type ${JSON.stringify(type)} at ${path}`,
      );
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

async function parseZip(
  bytes: Uint8Array,
  limits: MaterializationLimits,
  signal?: AbortSignal,
): Promise<InspectedArchiveEntry[]> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEndOfCentralDirectory(view);
  const count = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  if (
    count === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff
  )
    throw new MaterializationError(
      'ADAPTER_REQUIRED',
      'ZIP64 archives require an ecosystem adapter',
    );
  if (count > limits.maximumFiles || centralOffset + centralSize > eocd)
    throw unsafe('ARCHIVE_LIMIT', 'zip central directory');
  const entries: InspectedArchiveEntry[] = [];
  const ranges: Array<[number, number]> = [];
  let cursor = centralOffset;
  for (let index = 0; index < count; index += 1) {
    if (
      cursor + 46 > bytes.byteLength ||
      view.getUint32(cursor, true) !== 0x02014b50
    )
      throw unsafe('INVALID_ZIP', `central entry ${index}`);
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const crc = view.getUint32(cursor + 16, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const expandedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const externalAttributes = view.getUint32(cursor + 38, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    if ((flags & 1) !== 0)
      throw unsafe('ENCRYPTED_ARCHIVE', `zip entry ${index}`);
    if ((flags & 0x800) === 0 && nameBytes.some((byte) => byte > 0x7f))
      throw new MaterializationError(
        'ADAPTER_REQUIRED',
        'Non-UTF-8 ZIP names require an ecosystem adapter',
      );
    const rawName = utf8.decode(nameBytes);
    const path = validateArchivePath(rawName, limits);
    const unixMode = externalAttributes >>> 16;
    const fileType = unixMode & 0o170000;
    if (fileType === 0o120000) throw unsafe('SYMLINK_REJECTED', path);
    if ([0o010000, 0o020000, 0o060000, 0o140000].includes(fileType))
      throw unsafe('SPECIAL_FILE_REJECTED', path);
    if (
      localOffset + 30 > centralOffset ||
      view.getUint32(localOffset, true) !== 0x04034b50
    )
      throw unsafe('INVALID_ZIP', path);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > centralOffset) throw unsafe('TRUNCATED_ARCHIVE', path);
    if (ranges.some(([start, end]) => dataStart < end && dataEnd > start))
      throw unsafe('OVERLAPPING_ZIP_ENTRY', path);
    ranges.push([dataStart, dataEnd]);
    const compressed = bytes.subarray(dataStart, dataEnd);
    const directory = rawName.endsWith('/') || fileType === 0o040000;
    if (!directory && expandedSize > limits.maximumExpandedBytes)
      throw unsafe('EXPANDED_SIZE_LIMIT', path);
    if (!directory) validateRatio(expandedSize, compressedSize, limits);
    let data: Uint8Array;
    if (directory) data = new Uint8Array();
    else if (method === 0) data = compressed.slice();
    else if (method === 8)
      data = await decompress(compressed, 'deflate-raw', expandedSize, signal);
    else
      throw new MaterializationError(
        'ADAPTER_REQUIRED',
        `Unsupported ZIP compression method ${method}`,
      );
    if (!directory && data.byteLength !== expandedSize)
      throw unsafe('SIZE_MISMATCH', path);
    validateRatio(data.byteLength, compressedSize, limits);
    if (!directory && crc32(data) !== crc) throw unsafe('CRC_MISMATCH', path);
    entries.push({
      path,
      type: directory ? 'directory' : 'file',
      mode: unixMode & 0o111 ? 0o755 : 0o644,
      data,
    });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  if (cursor !== centralOffset + centralSize)
    throw unsafe('INVALID_ZIP', 'central directory size');
  return entries;
}

function validateEntries(
  entries: readonly InspectedArchiveEntry[],
  limits: MaterializationLimits,
): void {
  if (entries.length > limits.maximumFiles)
    throw unsafe('FILE_COUNT_LIMIT', `${entries.length}`);
  const paths = new Set<string>();
  const folded = new Set<string>();
  let expanded = 0;
  for (const entry of entries) {
    if (paths.has(entry.path)) throw unsafe('DUPLICATE_PATH', entry.path);
    const fold = entry.path.toLowerCase();
    if (folded.has(fold)) throw unsafe('CASE_COLLISION', entry.path);
    paths.add(entry.path);
    folded.add(fold);
    expanded += entry.data.byteLength;
    if (
      !Number.isSafeInteger(expanded) ||
      expanded > limits.maximumExpandedBytes
    )
      throw unsafe('EXPANDED_SIZE_LIMIT', `${expanded}`);
  }
  for (const entry of entries) {
    const parts = entry.path.split('/');
    for (let length = 1; length < parts.length; length += 1) {
      const ancestor = parts.slice(0, length).join('/');
      const parent = entries.find(({ path }) => path === ancestor);
      if (parent?.type === 'file')
        throw unsafe('FILE_AS_DIRECTORY', entry.path);
    }
  }
}

async function decompress(
  bytes: Uint8Array,
  format: 'gzip' | 'deflate-raw',
  maximumBytes: number,
  signal?: AbortSignal,
  overflowCode = 'EXPANDED_SIZE_LIMIT',
): Promise<Uint8Array> {
  const decompressor = new DecompressionStream(format as CompressionFormat);
  const writer = decompressor.writable.getWriter();
  const output = collectStream(decompressor.readable, maximumBytes, signal);
  const input = (async () => {
    signal?.throwIfAborted();
    await writer.write(Uint8Array.from(bytes));
    await writer.close();
  })();
  try {
    const [expanded] = await Promise.all([output, input]);
    return expanded;
  } catch (error) {
    await writer.abort(error).catch(() => undefined);
    await Promise.allSettled([output, input]);
    if (error instanceof RangeError)
      throw unsafe(overflowCode, `${maximumBytes}`);
    if (signal?.aborted) throw signal.reason ?? error;
    throw new MaterializationError(
      'INVALID_COMPRESSION',
      error instanceof Error ? error.message : 'Invalid compressed stream',
    );
  }
}

function validateRatio(
  expanded: number,
  compressed: number,
  limits: MaterializationLimits,
): void {
  if (
    expanded > 0 &&
    (compressed === 0 || expanded / compressed > limits.maximumCompressionRatio)
  )
    throw unsafe('COMPRESSION_RATIO_LIMIT', `${expanded}/${compressed}`);
}

function validateLimits(limits: MaterializationLimits): void {
  for (const [key, value] of Object.entries(limits))
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new RangeError(`${key} must be a positive safe integer`);
}

function tarText(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  return utf8.decode(end < 0 ? bytes : bytes.subarray(0, end));
}

function tarNumber(bytes: Uint8Array): number {
  if ((bytes[0] ?? 0) >= 0x80)
    throw new MaterializationError(
      'ADAPTER_REQUIRED',
      'Base-256 tar numbers require an ecosystem adapter',
    );
  const text = tarText(bytes).trim();
  if (!/^[0-7]*$/u.test(text)) throw unsafe('INVALID_TAR_NUMBER', text);
  const value = Number.parseInt(text || '0', 8);
  if (!Number.isSafeInteger(value) || value < 0)
    throw unsafe('INVALID_TAR_NUMBER', text);
  return value;
}

function verifyTarChecksum(header: Uint8Array): void {
  const expected = tarNumber(header.subarray(148, 156));
  let sum = 0;
  for (let index = 0; index < header.length; index += 1)
    sum += index >= 148 && index < 156 ? 32 : (header[index] ?? 0);
  if (sum !== expected) throw unsafe('TAR_CHECKSUM_MISMATCH', `${sum}`);
}

function findEndOfCentralDirectory(view: DataView): number {
  const start = Math.max(0, view.byteLength - 65_557);
  for (let offset = view.byteLength - 22; offset >= start; offset -= 1)
    if (view.getUint32(offset, true) === 0x06054b50) return offset;
  throw unsafe('INVALID_ZIP', 'end of central directory not found');
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1)
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes)
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    )
      return false;
    throw error;
  }
}

function unsafe(code: string, detail: string): MaterializationError {
  return new MaterializationError(
    code,
    `Unsafe archive rejected (${code}): ${detail}`,
  );
}

export class MaterializationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'MaterializationError';
  }
}
