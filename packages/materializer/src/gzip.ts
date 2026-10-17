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
    throw await refusal(
      bytes,
      error instanceof Error && error.message !== ''
        ? error.message
        : 'Invalid compressed stream',
      maximumBytes,
      signal,
    );
  }
  for (let at = decoded.consumed; at < bytes.byteLength; at += 1)
    if (bytes[at] !== 0) throw trailingData(bytes, decoded.consumed, at);
  return { expanded: decoded.output, streamEnd: decoded.consumed };
}

interface Inflated {
  output: Uint8Array;
  /** Input bytes the engine read: zlib leaves what follows the stream. */
  consumed: number;
}

/** Run a zlib engine over `bytes`, refusing more than `maximumBytes` of output. */
function inflate(
  engine: Gunzip | InflateRaw,
  bytes: Uint8Array,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<Inflated> {
  return new Promise((resolve, reject) => {
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
  return unsafe(
    'GZIP_TRAILING_DATA',
    `${bytes.byteLength - streamEnd} bytes follow the gzip stream at offset ${streamEnd}; the byte at offset ${at} is 0x${value}, and only zero bytes may follow it`,
  );
}

/**
 * zlib refused the stream; say where. The members are walked as zlib read
 * them, each one's end found by inflating its deflate data. Bytes after a
 * complete member that are neither zero nor another member's header are
 * trailing data (zlib's "incorrect header check"); a member that does not
 * decode is named by its offset. This only words the refusal: what is accepted
 * is decided by zlib above, never here.
 */
async function refusal(
  bytes: Uint8Array,
  reason: string,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<MaterializationError> {
  let at = 0;
  let budget = maximumBytes;
  for (let walked = 0; walked < MAXIMUM_DIAGNOSED_MEMBERS; walked += 1) {
    if (at >= bytes.byteLength || bytes[at] === 0) break;
    if (bytes[at] !== 0x1f || bytes[at + 1] !== 0x8b)
      return at > 0
        ? trailingData(bytes, at, at)
        : new MaterializationError('INVALID_COMPRESSION', reason);
    const body = memberBody(bytes, at);
    const deflated =
      body === undefined
        ? undefined
        : await inflate(
            createInflateRaw(),
            bytes.subarray(body),
            budget,
            signal,
          ).catch(() => undefined);
    // The deflate data, then the trailer's CRC-32 and length: 8 bytes.
    const end =
      body === undefined || deflated === undefined
        ? undefined
        : body + deflated.consumed + 8;
    if (end === undefined || deflated === undefined || end > bytes.byteLength)
      return new MaterializationError(
        'INVALID_COMPRESSION',
        `${reason}, in the gzip member at offset ${at}`,
      );
    at = end;
    budget -= deflated.output.byteLength;
  }
  return new MaterializationError('INVALID_COMPRESSION', reason);
}

/**
 * Where the deflate data of the member at `start` begins (RFC 1952 §2.3:
 * ID1 ID2 CM FLG MTIME XFL OS, then FEXTRA, FNAME, FCOMMENT and FHCRC as FLG
 * says), or undefined where zlib would refuse the header.
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
  if ((flags & 0x02) !== 0) at += 2;
  return at < bytes.byteLength ? at : undefined;
}
