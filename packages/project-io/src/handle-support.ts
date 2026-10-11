/**
 * Pieces every handle-relative backend shares: the refusal error and the
 * FileHandle-shaped wrapper around a raw descriptor.
 */

import {
  close as closeCb,
  fchmod as fchmodCb,
  fstat as fstatCb,
  fsync as fsyncCb,
  read as readCb,
  write as writeCb,
  type BigIntStats,
  type Stats,
} from 'node:fs';
import { type FileHandle } from 'node:fs/promises';
import { promisify } from 'node:util';

export class StableHandleError extends Error {
  readonly code = 'UNSAFE_PATH';

  constructor(message: string) {
    super(message);
    this.name = 'StableHandleError';
  }
}

/**
 * Where a module of this package was loaded from, read off a stack trace, in a
 * form `createRequire` accepts: a `file:` URL (ESM frames) or an absolute path
 * (CommonJS frames, or a test run from source).
 *
 * The package builds twice, and the CommonJS build cannot name `import.meta`,
 * so a module cannot ask for its own URL. A frame looks like
 * `file:///D:/a/x/handle-path.js:359:21` from ESM and `D:\a\x\handle-path.js:359:21`
 * from CommonJS. A URL is handed on whole rather than cut down to
 * `/D:/a/x/handle-path.js`, which names no file on Windows.
 *
 * `module` is the file's base name without extension, a constant of the caller.
 */
export function locateModuleFile(
  stack: string,
  module: 'handle-path' | 'handle-libc',
): string | undefined {
  const frame = new RegExp(
    `((?:file:\\/\\/\\/|[A-Za-z]:[\\\\/]|\\/)[^()\\r\\n]*?${module}\\.[cm]?[jt]s)(?::\\d+){0,2}[)\\r\\n]`,
    'u',
  ).exec(`${stack}\n`);
  return frame?.[1];
}

const closeFd = promisify(closeCb);
const fsyncFd = promisify(fsyncCb);
const fchmodFd = promisify(fchmodCb);

/**
 * Wrap a raw descriptor in the subset of FileHandle the project tools use.
 *
 * `guardClose` makes close() idempotent. Node's own FileHandle already is, and
 * a descriptor number is reused as soon as it is closed, so a second close of
 * a bare number could close somebody else's file. The Windows backend predates
 * the guard and keeps its original behavior.
 */
export function wrapFd(fd: number, guardClose = false): FileHandle {
  let closed = false;
  const handle = {
    get fd() {
      return fd;
    },
    async close() {
      if (guardClose) {
        if (closed) return;
        closed = true;
      }
      await closeFd(fd);
    },
    async stat(options?: { bigint?: boolean }) {
      return await new Promise<Stats | BigIntStats>((resolve, reject) => {
        if (options?.bigint === true) {
          fstatCb(fd, { bigint: true }, (error, stats) =>
            error ? reject(error) : resolve(stats),
          );
          return;
        }
        fstatCb(fd, (error, stats) => (error ? reject(error) : resolve(stats)));
      });
    },
    async sync() {
      await fsyncFd(fd);
    },
    async chmod(mode: number) {
      await fchmodFd(fd, mode);
    },
    async writeFile(contents: string | Uint8Array) {
      const bytes =
        typeof contents === 'string' ? Buffer.from(contents) : contents;
      let offset = 0;
      while (offset < bytes.byteLength) {
        const written = await new Promise<number>((resolve, reject) => {
          writeCb(
            fd,
            bytes,
            offset,
            bytes.byteLength - offset,
            offset,
            (error, n) => (error ? reject(error) : resolve(n)),
          );
        });
        if (written === 0) break;
        offset += written;
      }
    },
    async write(
      buffer: Uint8Array,
      offset = 0,
      length = buffer.byteLength - offset,
      position: number | null = null,
    ) {
      const bytesWritten = await new Promise<number>((resolve, reject) => {
        writeCb(fd, buffer, offset, length, position, (error, n) =>
          error ? reject(error) : resolve(n),
        );
      });
      return { bytesWritten, buffer };
    },
    async read(
      buffer: Uint8Array,
      offset: number,
      length: number,
      position: number | null,
    ) {
      const bytesRead = await new Promise<number>((resolve, reject) => {
        readCb(fd, buffer, offset, length, position, (error, n) =>
          error ? reject(error) : resolve(n),
        );
      });
      return { bytesRead, buffer };
    },
  };
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  return handle as FileHandle;
}
