/**
 * FSCTL_GET_REPARSE_POINT on an open NT handle.
 *
 * Kept apart from `handle-path.ts` and given the NT API to call, so that the
 * recursive removal there and the junction code in `handle-nt-link.ts` read a
 * reparse point the same way without importing each other.
 */

import { StableHandleError } from './handle-support.js';

const FSCTL_GET_REPARSE_POINT = 0x000900a8;
const STATUS_SUCCESS = 0;
const STATUS_NOT_A_REPARSE_POINT = 0xc0000275;
/**
 * What a volume without reparse points answers: FAT and exFAT hold none, so
 * they have nothing to refuse.
 */
const NO_REPARSE_SUPPORT = new Set([
  0xc0000010, // STATUS_INVALID_DEVICE_REQUEST
  0xc00000bb, // STATUS_NOT_SUPPORTED
  0xc000000d, // STATUS_INVALID_PARAMETER
]);
/** Header (8) plus the most a reparse buffer may carry (16 KiB). */
const REPARSE_BUFFER_BYTES = 16 * 1024 + 8;

/** The two NT entry points the read needs, as `handle-path.ts` binds them. */
export interface NtFsControl {
  getOsFHandle(fd: number): object;
  NtFsControlFile(...args: never[]): number;
}

/**
 * The reparse data of the object behind `fd`, whole, or undefined when it is not
 * a reparse point. Any other answer is an error and is thrown: a handle that
 * cannot say whether it is a link is not treated as one that is not.
 */
export function readReparse(api: NtFsControl, fd: number): Buffer | undefined {
  const output = Buffer.alloc(REPARSE_BUFFER_BYTES);
  const status =
    api.NtFsControlFile(
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      ...([
        api.getOsFHandle(fd),
        null,
        null,
        null,
        Buffer.alloc(16),
        FSCTL_GET_REPARSE_POINT,
        null,
        0,
        output,
        output.length,
      ] as never[]),
    ) >>> 0;
  if (status === STATUS_NOT_A_REPARSE_POINT || NO_REPARSE_SUPPORT.has(status))
    return undefined;
  if (status !== STATUS_SUCCESS)
    throw new StableHandleError(
      `FSCTL_GET_REPARSE_POINT on fd ${fd} failed with status 0x${status.toString(16)}`,
    );
  return output.subarray(0, 8 + output.readUInt16LE(4));
}
