import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, readdir, rmdir, type FileHandle } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { PACKAGE_TREE_LIMITS, segmentProblem } from '@openpacker/adapter-core';
import { collisionKey } from '@openpacker/adapter-core';
import { collectStream, type ArtifactSource } from '@openpacker/artifact-model';
import {
  compareCanonicalStrings,
  safeEcho,
  sha256,
} from '@openpacker/canonical';
import type { ArtifactDescriptor, Digest } from '@openpacker/contracts';
import {
  mkdirChild,
  mkdtempChild,
  O_DIRECTORY,
  openChild,
  openStableDirectory as openStableDirectoryShared,
  removeChild,
  renameChild,
  supportsStableHandles,
} from '@openpacker/project-io';
import { MAXIMUM_PAX_HEADER_BYTES, parsePaxRecords } from './pax.js';

export type ArchiveFormat = 'tar' | 'tar+gzip' | 'zip';

export interface MaterializationLimits {
  maximumFiles: number;
  maximumExpandedBytes: number;
  maximumCompressedBytes: number;
  maximumCompressionRatio: number;
  maximumMemoryBytes: number;
  maximumPathBytes: number;
  maximumDepth: number;
  /**
   * Accept an archive that spells one path two ways, which npm's own extractor
   * does: a `.` segment names the directory it is in (`package/./dist/index.js`
   * is `package/dist/index.js`), and a file listed twice with the same bytes
   * and the same mode is one file whichever copy is written first. Off by
   * default, and the exploit corpus keeps rejecting both: an ecosystem whose
   * published packages carry them (agent-base@7.1.4 does) asks for it by name.
   * Differing content at one path, `..`, and an empty segment are refused
   * either way.
   */
  acceptRedundantEntries?: boolean;
}

export const DEFAULT_MATERIALIZATION_LIMITS: MaterializationLimits = {
  maximumFiles: 10_000,
  maximumExpandedBytes: 64 * 1024 * 1024,
  maximumCompressedBytes: 64 * 1024 * 1024,
  maximumCompressionRatio: 32,
  maximumMemoryBytes: 192 * 1024 * 1024,
  // The bounds of a path in a package: one definition, with the store's.
  maximumPathBytes: PACKAGE_TREE_LIMITS.maximumPathBytes,
  maximumDepth: PACKAGE_TREE_LIMITS.maximumDepth,
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
  const tolerant = limits.acceptRedundantEntries === true;
  const parts = path.split('/').filter((part) => !tolerant || part !== '.');
  if (
    path === '' ||
    parts.length === 0 ||
    parts.some((part) => part === '' || part === '.' || part === '..')
  )
    throw unsafe('PATH_TRAVERSAL', input);
  // The names an archive refuses: one rule, the one a patch's paths meet.
  for (const part of parts) {
    const problem = segmentProblem(part);
    if (problem !== undefined) throw unsafe(problem.code, input);
  }
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
  assertMemoryBudget(
    bytes.byteLength,
    format === 'tar+gzip' ? gzipLimit : bytes.byteLength,
    limits,
  );
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
  assertMemoryBudget(bytes.byteLength, expanded.byteLength, limits);
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
  if (!supportsStableHandles())
    throw unsafe(
      'UNSAFE_STAGING',
      'Stable materialization handles are unavailable on this platform',
    );
  const parent = resolve(dirname(input.destination));
  const destName = basename(input.destination);
  const parentHandle = await openStableDirectoryShared(parent);
  let stagingHandle: FileHandle | undefined;
  try {
    const target = join(parent, destName);
    const stagingName = await mkdtempChild(
      parentHandle,
      `.${destName}.openpacker-`,
    );
    stagingHandle = await openChild(
      parentHandle,
      stagingName,
      constants.O_RDONLY | O_DIRECTORY | constants.O_NOFOLLOW,
    );
    let published = false;
    try {
      if (await exists(target)) {
        if (!input.managedDestination)
          throw new MaterializationError(
            'DESTINATION_EXISTS',
            'Destination already exists; materialization never merges or overwrites prefixes',
          );
        const targetStat = await lstat(target);
        if (!targetStat.isDirectory() || targetStat.isSymbolicLink())
          throw unsafe('UNSAFE_MANAGED_DESTINATION', input.destination);
        if ((await readdir(target)).length > 0)
          throw new MaterializationError(
            'DESTINATION_EXISTS',
            'Managed destination must be empty before atomic materialization',
          );
        await rmdir(target);
      }
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
        await ensureStageDirectory(stagingHandle, entry.path.split('/'));
      }
      for (const entry of entries.filter(({ type }) => type === 'file')) {
        input.signal?.throwIfAborted();
        await writeStageFile(
          stagingHandle,
          entry.path.split('/'),
          entry.data,
          entry.mode,
        );
        files.push({
          path: entry.path,
          size: entry.data.byteLength,
          digest: await sha256(entry.data),
          mode: entry.mode,
        });
      }
      input.signal?.throwIfAborted();
      await renameChild(parentHandle, stagingName, destName);
      published = true;
      await assertNamedDirectory(target, stagingHandle);
      files.sort((left, right) =>
        compareCanonicalStrings(left.path, right.path),
      );
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
      await removeChild(parentHandle, published ? destName : stagingName, {
        recursive: true,
        force: true,
      }).catch(() => undefined);
      throw error;
    } finally {
      await stagingHandle?.close();
    }
  } finally {
    await parentHandle.close();
  }
}

async function openDirectoryAt(
  parent: FileHandle,
  name: string,
): Promise<FileHandle> {
  const handle = await openChild(
    parent,
    name,
    constants.O_RDONLY | O_DIRECTORY | constants.O_NOFOLLOW,
  );
  if (!(await handle.stat()).isDirectory()) {
    await handle.close();
    throw unsafe('UNSAFE_STAGING', name);
  }
  return handle;
}

async function ensureStageDirectory(
  root: FileHandle,
  parts: readonly string[],
): Promise<void> {
  let current = root;
  const opened: FileHandle[] = [];
  try {
    for (const part of parts) {
      await mkdirChild(current, part).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
      });
      current = await openDirectoryAt(current, part);
      opened.push(current);
    }
  } finally {
    await Promise.all(opened.reverse().map(async (handle) => handle.close()));
  }
}

async function writeStageFile(
  root: FileHandle,
  parts: readonly string[],
  bytes: Uint8Array,
  mode: number,
): Promise<void> {
  const name = parts.at(-1)!;
  await ensureStageDirectory(root, parts.slice(0, -1));
  let parent = root;
  const opened: FileHandle[] = [];
  try {
    for (const part of parts.slice(0, -1)) {
      parent = await openDirectoryAt(parent, part);
      opened.push(parent);
    }
    const file = await openChild(
      parent,
      name,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      mode,
    );
    try {
      await file.write(bytes);
      await file.chmod(mode);
      await file.sync();
    } finally {
      await file.close();
    }
  } finally {
    await Promise.all(opened.reverse().map(async (handle) => handle.close()));
  }
}

async function assertNamedDirectory(path: string, handle: FileHandle) {
  const [held, named] = await Promise.all([
    handle.stat({ bigint: true }),
    lstat(path, { bigint: true }),
  ]);
  if (held.dev !== named.dev || held.ino !== named.ino)
    throw unsafe('UNSAFE_STAGING', path);
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
      const chunk = Uint8Array.from(item.value);
      hash.update(chunk);
      chunks.push(chunk);
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
  if (createHash('sha256').update(bytes).digest('hex') !== digest)
    throw new MaterializationError(
      'DIGEST_MISMATCH',
      'Artifact bytes changed after stream verification',
    );
  return bytes;
}

function parseTar(
  bytes: Uint8Array,
  limits: MaterializationLimits,
): InspectedArchiveEntry[] {
  const entries: InspectedArchiveEntry[] = [];
  const seen = new Map<string, InspectedArchiveEntry>();
  // The records of an extended header (`x`) apply to the one entry after it.
  let pending: Map<string, string> | undefined;
  let offset = 0;
  let count = 0;
  while (offset + 512 <= bytes.byteLength) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    count += 1;
    if (count > limits.maximumFiles)
      throw unsafe('FILE_COUNT_LIMIT', `${count}`);
    verifyTarChecksum(header);
    const name = tarText(header.subarray(0, 100));
    const prefix = tarText(header.subarray(345, 500));
    const size = tarNumber(header.subarray(124, 136));
    const mode = tarNumber(header.subarray(100, 108));
    const type = String.fromCharCode(header[156] ?? 0);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (!Number.isSafeInteger(dataEnd) || dataEnd > bytes.byteLength)
      throw unsafe('TRUNCATED_ARCHIVE', name);
    if (type === 'x' || type === 'g') {
      // A path longer than a ustar header holds is written as a pax record
      // (npm's own tar does it); the header's own name, `PaxHeader/...`, names
      // nothing. What a record may change is narrow: the path of the entry
      // after it. A path for every entry is refused, and so is a size that is
      // not the one the entry's own header gives (an entry past the 12 octal
      // digits of a header is far beyond the limits anyway).
      if (size > MAXIMUM_PAX_HEADER_BYTES)
        throw unsafe('PAX_HEADER_LIMIT', `${size}`);
      const records = parsePaxRecords(bytes.subarray(dataStart, dataEnd));
      if (records === undefined) throw unsafe('INVALID_PAX_HEADER', name);
      if (type === 'g') {
        if (records.has('path') || records.has('size'))
          throw unsafe('PAX_GLOBAL_REJECTED', name);
      } else {
        if (pending !== undefined) throw unsafe('INVALID_PAX_HEADER', name);
        pending = records;
      }
      offset = dataStart + Math.ceil(size / 512) * 512;
      continue;
    }
    if (pending?.has('size') && pending.get('size') !== String(size))
      throw unsafe('PAX_SIZE_REJECTED', name);
    const path = validateArchivePath(
      pending?.get('path') ?? (prefix ? `${prefix}/${name}` : name),
      limits,
    );
    pending = undefined;
    if (type === '\0' || type === '0' || type === '7') {
      const file: InspectedArchiveEntry = {
        path,
        type: 'file',
        mode: mode & 0o111 ? 0o755 : 0o644,
        data: bytes.slice(dataStart, dataEnd),
      };
      // See `acceptRedundantEntries`: only a repeat of the very same file is
      // dropped; any other repeat is still a duplicate, refused below.
      const earlier = seen.get(path);
      if (
        limits.acceptRedundantEntries === true &&
        earlier !== undefined &&
        sameFile(earlier, file)
      ) {
        offset = dataStart + Math.ceil(size / 512) * 512;
        continue;
      }
      seen.set(path, file);
      entries.push(file);
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
        `Unsupported tar entry type ${JSON.stringify(type)} at ${safeEcho(path, 256)}`,
      );
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  if (pending !== undefined)
    throw unsafe(
      'INVALID_PAX_HEADER',
      'an extended header with no entry after it',
    );
  return entries;
}

function sameFile(
  left: InspectedArchiveEntry,
  right: InspectedArchiveEntry,
): boolean {
  return (
    left.type === 'file' &&
    right.type === 'file' &&
    left.mode === right.mode &&
    Buffer.from(left.data).equals(right.data)
  );
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
  const paths = new Set<string>();
  const pathTypes = new Map<string, 'file' | 'directory'>();
  const foldedPaths = new Set<string>();
  const requiredDirectories = new Set<string>();
  let declaredExpanded = 0;
  let actualExpanded = 0;
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
    if (paths.has(path)) throw unsafe('DUPLICATE_PATH', path);
    const foldedPath = path.toLowerCase();
    if (foldedPaths.has(foldedPath)) throw unsafe('CASE_COLLISION', path);
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
    const parts = path.split('/');
    for (let length = 1; length < parts.length; length += 1) {
      const ancestor = parts.slice(0, length).join('/');
      if (pathTypes.get(ancestor) === 'file')
        throw unsafe('FILE_AS_DIRECTORY', path);
      requiredDirectories.add(ancestor);
    }
    if (!directory && requiredDirectories.has(path))
      throw unsafe('FILE_AS_DIRECTORY', path);
    paths.add(path);
    pathTypes.set(path, directory ? 'directory' : 'file');
    foldedPaths.add(foldedPath);
    if (!directory) {
      if (expandedSize > limits.maximumExpandedBytes - declaredExpanded)
        throw unsafe('EXPANDED_SIZE_LIMIT', path);
      declaredExpanded += expandedSize;
      assertMemoryBudget(bytes.byteLength, declaredExpanded, limits);
    }
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
    if (!directory) {
      if (data.byteLength > limits.maximumExpandedBytes - actualExpanded)
        throw unsafe('EXPANDED_SIZE_LIMIT', path);
      actualExpanded += data.byteLength;
      assertMemoryBudget(bytes.byteLength, actualExpanded, limits);
    }
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
  const types = new Map<string, InspectedArchiveEntry['type']>();
  const folded = new Set<string>();
  let expanded = 0;
  for (const entry of entries) {
    if (paths.has(entry.path)) throw unsafe('DUPLICATE_PATH', entry.path);
    const fold = collisionKey(entry.path);
    if (folded.has(fold)) throw unsafe('CASE_COLLISION', entry.path);
    paths.add(entry.path);
    types.set(entry.path, entry.type);
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
      if (types.get(ancestor) === 'file')
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
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
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

function assertMemoryBudget(
  compressed: number,
  expanded: number,
  limits: MaterializationLimits,
): void {
  if (compressed + expanded * 2 > limits.maximumMemoryBytes)
    throw unsafe('MEMORY_LIMIT', `${compressed}+2*${expanded}`);
}

function validateLimits(limits: MaterializationLimits): void {
  for (const [key, value] of Object.entries(limits)) {
    if (key === 'acceptRedundantEntries') {
      if (typeof value !== 'boolean')
        throw new RangeError(`${key} must be true or false`);
      continue;
    }
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new RangeError(`${key} must be a positive safe integer`);
  }
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

/**
 * An archive was refused. The detail is usually a name from the archive, which
 * is a registry's to choose: one line, with no escape sequence in it, and cut.
 */
function unsafe(code: string, detail: string): MaterializationError {
  return new MaterializationError(
    code,
    `Unsafe archive rejected (${code}): ${safeEcho(detail, 256)}`,
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
