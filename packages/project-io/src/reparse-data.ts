/**
 * The bytes of a Windows junction, and the paths that go into them.
 *
 * Pure, so every layout below is checked on any platform against the
 * documented `REPARSE_DATA_BUFFER`, and nothing here calls the system. The NT
 * calls that send and read these bytes are in `handle-nt-link.ts`.
 *
 * A junction (`IO_REPARSE_TAG_MOUNT_POINT`) needs no privilege to create, which
 * is why a workspace member is linked by one on Windows, and it holds an
 * absolute target: the NT path `\??\C:\project\packages\member` as its
 * substitute name and the same without the prefix as its print name. There is
 * no relative form, so the text the caller gave (`../../packages/member`) is
 * resolved against the project root once, here, and converted back to that
 * relative form when it is read.
 */

import { win32 } from 'node:path';

export const IO_REPARSE_TAG_MOUNT_POINT = 0xa0000003;
export const IO_REPARSE_TAG_SYMLINK = 0xa000000c;

/** `REPARSE_DATA_BUFFER` header: tag, data length, reserved. */
const HEADER_BYTES = 8;
/** The four 16-bit offsets and lengths that begin a mount-point buffer. */
const MOUNT_POINT_FIELDS_BYTES = 8;
/** The same plus the 32-bit flags of a symbolic-link buffer. */
const SYMLINK_FIELDS_BYTES = 12;
/** `MAXIMUM_REPARSE_DATA_BUFFER_SIZE`, the most any reparse buffer may hold. */
export const MAXIMUM_REPARSE_BYTES = 16 * 1024;
/** Set in a symbolic link's flags when its substitute name is relative. */
const SYMLINK_FLAG_RELATIVE = 1;

/** What a reparse buffer says, in the words the rest of the package uses. */
export interface ReparseData {
  tag: number;
  /** Where it points, as the system resolves it: `\??\C:\a`. */
  substitute: string;
  /** Where it points, as an application shows it: `C:\a`. */
  print: string;
  /** A symbolic link whose substitute name is relative to the link. */
  relative: boolean;
}

/** `\??\C:\a` for `C:\a`, `\??\UNC\server\share\a` for `\\server\share\a`. */
export function ntSubstituteName(absolute: string): string {
  const path = absolute.replace(/(?<=[^\\:])\\+$/u, '');
  if (path.startsWith('\\\\?\\UNC\\')) return `\\??\\UNC\\${path.slice(8)}`;
  if (path.startsWith('\\\\?\\')) return `\\??\\${path.slice(4)}`;
  if (path.startsWith('\\\\')) return `\\??\\UNC\\${path.slice(2)}`;
  return `\\??\\${path}`;
}

/** The inverse of {@link ntSubstituteName}: `C:\a` for `\??\C:\a`. */
export function pathOfSubstituteName(substitute: string): string {
  if (substitute.startsWith('\\??\\UNC\\')) return `\\\\${substitute.slice(8)}`;
  if (substitute.startsWith('\\??\\')) return substitute.slice(4);
  if (substitute.startsWith('\\\\?\\')) return substitute.slice(4);
  return substitute;
}

/**
 * The absolute path a link in `directory` with text `target` points at.
 * `directory` is project-root relative and written with `/`, `target` likewise;
 * `projectRoot` is the root as a Windows absolute path.
 */
export function junctionPath(
  projectRoot: string,
  directory: string,
  target: string,
): string {
  return win32.resolve(projectRoot, ...directory.split('/'), target);
}

/**
 * The text a link would have been given, from where a junction points: the
 * path relative to the link's directory, written with `/`. A target on another
 * drive has no relative form and is returned absolute, which no valid target
 * equals, so a link someone else made is never mistaken for one of ours.
 */
export function relativeTargetOf(
  projectRoot: string,
  directory: string,
  absolute: string,
): string {
  const from = win32.resolve(projectRoot, ...directory.split('/'));
  const relative = win32.relative(from, win32.resolve(absolute));
  if (win32.isAbsolute(relative)) return absolute;
  return relative === '' ? '.' : relative.split('\\').join('/');
}

/** Whether two Windows paths name the same place, which NTFS decides without case. */
export function samePath(left: string, right: string): boolean {
  return (
    win32.resolve(left).toLowerCase() === win32.resolve(right).toLowerCase()
  );
}

/** A `REPARSE_DATA_BUFFER` for `IO_REPARSE_TAG_MOUNT_POINT`. */
export function encodeMountPoint(substitute: string, print: string): Buffer {
  const names = Buffer.concat([
    Buffer.from(substitute, 'utf16le'),
    Buffer.alloc(2),
    Buffer.from(print, 'utf16le'),
    Buffer.alloc(2),
  ]);
  const substituteBytes = substitute.length * 2;
  const dataBytes = MOUNT_POINT_FIELDS_BYTES + names.length;
  if (dataBytes > MAXIMUM_REPARSE_BYTES - HEADER_BYTES)
    throw new RangeError(
      `A junction to ${print} needs ${dataBytes} bytes of reparse data; the most is ${MAXIMUM_REPARSE_BYTES - HEADER_BYTES}`,
    );
  const buffer = Buffer.alloc(HEADER_BYTES + dataBytes);
  buffer.writeUInt32LE(IO_REPARSE_TAG_MOUNT_POINT, 0);
  buffer.writeUInt16LE(dataBytes, 4);
  buffer.writeUInt16LE(0, 6);
  buffer.writeUInt16LE(0, 8);
  buffer.writeUInt16LE(substituteBytes, 10);
  buffer.writeUInt16LE(substituteBytes + 2, 12);
  buffer.writeUInt16LE(print.length * 2, 14);
  names.copy(buffer, HEADER_BYTES + MOUNT_POINT_FIELDS_BYTES);
  return buffer;
}

function nameAt(
  buffer: Buffer,
  base: number,
  offset: number,
  length: number,
): string {
  const start = base + offset;
  if (start + length > buffer.length)
    throw new RangeError(
      `A reparse name of ${length} bytes at ${offset} runs past the ${buffer.length}-byte buffer`,
    );
  return buffer.toString('utf16le', start, start + length);
}

/**
 * Read a `REPARSE_DATA_BUFFER` that holds a mount point or a symbolic link.
 * Another tag (a OneDrive placeholder, a deduplicated file) is not a link this
 * package makes or follows, and is `undefined`.
 */
export function decodeReparse(buffer: Buffer): ReparseData | undefined {
  if (buffer.length < HEADER_BYTES + MOUNT_POINT_FIELDS_BYTES)
    throw new RangeError(
      `A reparse buffer of ${buffer.length} bytes is shorter than its header`,
    );
  const tag = buffer.readUInt32LE(0);
  if (tag === IO_REPARSE_TAG_MOUNT_POINT) {
    const base = HEADER_BYTES + MOUNT_POINT_FIELDS_BYTES;
    return {
      tag,
      substitute: nameAt(
        buffer,
        base,
        buffer.readUInt16LE(8),
        buffer.readUInt16LE(10),
      ),
      print: nameAt(
        buffer,
        base,
        buffer.readUInt16LE(12),
        buffer.readUInt16LE(14),
      ),
      relative: false,
    };
  }
  if (tag === IO_REPARSE_TAG_SYMLINK) {
    if (buffer.length < HEADER_BYTES + SYMLINK_FIELDS_BYTES)
      throw new RangeError(
        `A symbolic-link reparse buffer of ${buffer.length} bytes is shorter than its fields`,
      );
    const base = HEADER_BYTES + SYMLINK_FIELDS_BYTES;
    return {
      tag,
      substitute: nameAt(
        buffer,
        base,
        buffer.readUInt16LE(8),
        buffer.readUInt16LE(10),
      ),
      print: nameAt(
        buffer,
        base,
        buffer.readUInt16LE(12),
        buffer.readUInt16LE(14),
      ),
      relative: (buffer.readUInt32LE(16) & SYMLINK_FLAG_RELATIVE) !== 0,
    };
  }
  return undefined;
}
