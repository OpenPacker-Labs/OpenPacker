/**
 * The gzip stream of a `tar+gzip` archive, decoded by Node's zlib as npm
 * (node-tar over minizlib) and pnpm (`zlib.gunzipSync`) decode it: member after
 * member, each checked against its CRC-32 and length, until the input ends or
 * the byte after a member is zero. node_zlib.cc stops there and calls what
 * follows padding; GNU tar wrote archives padded with zeros to a whole record,
 * and the npm registry still serves some (sylvester@0.0.21).
 *
 * One rule is stricter than Node's. Node ignores everything after that zero
 * byte, so it would extract an archive that hides other bytes, another member
 * included, behind one zero. Here every byte after the stream must be zero, and
 * anything else is GZIP_TRAILING_DATA, by its offset. The bytes are the whole
 * download, already within `maximumCompressedBytes` and already hashed: the
 * scan reads nothing that is not held, and changes nothing that was hashed.
 */

import {
  crc32,
  createGunzip,
  createInflateRaw,
  type Gunzip,
  type InflateRaw,
} from 'node:zlib';
import { MaterializationError, unsafe } from './errors.js';

export interface GunzippedArchive {
  /** Every member's output, in order: what Node's gunzip returns. */
  expanded: Uint8Array;
  /** Where the last member ends: the archive's length unless padding follows. */
  streamEnd: number;
}

/** Members walked to say where a stream zlib refused goes wrong. */
const MAXIMUM_DIAGNOSED_MEMBERS = 1024;

export async function gunzipArchive(
  bytes: Uint8Array,
  maximumBytes: number,
  signal?: AbortSignal,
  overflowCode = 'EXPANDED_SIZE_LIMIT',
): Promise<GunzippedArchive> {
  signal?.throwIfAborted();
  let decoded: Inflated;
  try {
    decoded = await inflate(createGunzip(), bytes, maximumBytes, signal);
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    if (error instanceof RangeError)
      throw unsafe(overflowCode, `${maximumBytes}`);
    const refused = await describeRefusal(
      bytes,
      error instanceof Error && error.message !== ''
        ? error.message
        : 'Invalid compressed stream',
      maximumBytes,
      signal,
    );
    // An abort while the walk ran is the abort, not this refusal.
    signal?.throwIfAborted();
    throw refused;
  }
  for (let at = decoded.consumed; at < bytes.byteLength; at += 1)
    if (bytes[at] !== 0) throw trailingData(bytes, decoded.consumed, at);
  return { expanded: decoded.output, streamEnd: decoded.consumed };
}

export interface Inflated {
  output: Uint8Array;
  /** Input bytes the engine read: zlib leaves what follows the stream. */
  consumed: number;
}

/** Run a zlib engine over `bytes`, refusing more than `maximumBytes` of output. */
export function inflate(
  engine: Gunzip | InflateRaw,
  bytes: Uint8Array,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<Inflated> {
  return new Promise((resolve, reject) => {
    // A listener added to a signal already aborted would never be called.
    if (signal?.aborted) {
      engine.destroy();
      reject(signal.reason);
      return;
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    const abort = () => engine.destroy(new Error('aborted'));
    signal?.addEventListener('abort', abort, { once: true });
    engine.on('data', (chunk: Uint8Array) => {
      size += chunk.byteLength;
      if (size > maximumBytes)
        engine.destroy(new RangeError(`output exceeds ${maximumBytes}`));
      else chunks.push(chunk);
    });
    engine.once('error', (error) => {
      signal?.removeEventListener('abort', abort);
      reject(error);
    });
    engine.once('end', () => {
      signal?.removeEventListener('abort', abort);
      const output = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.byteLength;
      }
      resolve({ output, consumed: engine.bytesWritten });
    });
    engine.end(bytes);
  });
}

function trailingData(
  bytes: Uint8Array,
  streamEnd: number,
  at: number,
): MaterializationError {
  const value = (bytes[at] ?? 0).toString(16).padStart(2, '0');
  const count = bytes.byteLength - streamEnd;
  return unsafe(
    'GZIP_TRAILING_DATA',
    `${count} ${count === 1 ? 'byte follows' : 'bytes follow'} the gzip stream at offset ${streamEnd}; the byte at offset ${at} is 0x${value}, and only zero bytes may follow it`,
  );
}

/**
 * zlib refused the stream; say why and where. The members are walked and
 * checked as zlib checks them: the header (and its CRC when FHCRC is set), the
 * deflate data, the trailer's CRC-32 and length. The first member that fails
 * is the refusal, `INVALID_COMPRESSION` at its offset, and the walk goes no
 * further. Bytes after a member that passes that are neither zero nor another
 * member's header are trailing data (zlib's "incorrect header check"). The walk
 * has its own output budget and member count; past either it names no offset.
 * It only words a refusal: what is accepted is decided by zlib above, never
 * here.
 */
export async function describeRefusal(
  bytes: Uint8Array,
  reason: string,
  budget: number,
  signal?: AbortSignal,
): Promise<MaterializationError> {
  let at = 0;
  let left = budget;
  for (let walked = 0; walked < MAXIMUM_DIAGNOSED_MEMBERS; walked += 1) {
    signal?.throwIfAborted();
    if (at >= bytes.byteLength || bytes[at] === 0) break;
    if (bytes[at] !== 0x1f || bytes[at + 1] !== 0x8b)
      return at > 0
        ? trailingData(bytes, at, at)
        : new MaterializationError('INVALID_COMPRESSION', reason);
    const checked = await checkMember(bytes, at, left, signal);
    if (checked.kind === 'over-budget') break;
    if (checked.kind === 'refused')
      return new MaterializationError(
        'INVALID_COMPRESSION',
        `${reason}, in the gzip member at offset ${at}`,
      );
    at = checked.end;
    left -= checked.output;
  }
  return new MaterializationError('INVALID_COMPRESSION', reason);
}

type CheckedMember =
  | { kind: 'passed'; end: number; output: number }
  | { kind: 'refused' }
  | { kind: 'over-budget' };

/** The member at `start`, checked as zlib checks it. */
async function checkMember(
  bytes: Uint8Array,
  start: number,
  budget: number,
  signal?: AbortSignal,
): Promise<CheckedMember> {
  const body = memberBody(bytes, start);
  if (body === undefined) return { kind: 'refused' };
  let deflated: Inflated;
  try {
    deflated = await inflate(
      createInflateRaw(),
      bytes.subarray(body),
      budget,
      signal,
    );
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    return { kind: error instanceof RangeError ? 'over-budget' : 'refused' };
  }
  // The deflate data, then the trailer: CRC-32 and length, 8 bytes.
  const end = body + deflated.consumed + 8;
  if (end > bytes.byteLength) return { kind: 'refused' };
  const trailer = new DataView(bytes.buffer, bytes.byteOffset + end - 8, 8);
  return trailer.getUint32(0, true) === crc32(deflated.output) &&
    trailer.getUint32(4, true) === deflated.output.byteLength % 2 ** 32
    ? { kind: 'passed', end, output: deflated.output.byteLength }
    : { kind: 'refused' };
}

/**
 * Where the deflate data of the member at `start` begins (RFC 1952 §2.3:
 * ID1 ID2 CM FLG MTIME XFL OS, then FEXTRA, FNAME, FCOMMENT and FHCRC as FLG
 * says), or undefined where zlib would refuse the header, its CRC included.
 */
function memberBody(bytes: Uint8Array, start: number): number | undefined {
  const flags = bytes[start + 3] ?? 0xff;
  if (bytes[start + 2] !== 8 || (flags & 0xe0) !== 0) return undefined;
  let at = start + 10;
  if ((flags & 0x04) !== 0)
    at += 2 + (bytes[at] ?? 0) + ((bytes[at + 1] ?? 0) << 8);
  for (const field of [0x08, 0x10])
    if ((flags & field) !== 0) {
      const end = bytes.indexOf(0, at);
      if (end < 0) return undefined;
      at = end + 1;
    }
  if ((flags & 0x02) !== 0) {
    if (at + 2 > bytes.byteLength) return undefined;
    const stored = (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8);
    if ((crc32(bytes.subarray(start, at)) & 0xffff) !== stored)
      return undefined;
    at += 2;
  }
  return at < bytes.byteLength ? at : undefined;
}
