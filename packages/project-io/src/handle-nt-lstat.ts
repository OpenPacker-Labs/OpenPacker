/**
 * What a name is on Windows, looked at and not followed.
 *
 * The name is opened as itself (`FILE_OPEN_REPARSE_POINT`) and the open handle
 * is statted. The seam is a function of an already-open handle so that the
 * decision can be run on any platform against a stand-in for the handle.
 */

import type { BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';

/** Stat a handle opened on the name itself, then close it. */
export async function lstatOpened(handle: FileHandle): Promise<BigIntStats> {
  try {
    return await handle.stat({ bigint: true });
  } finally {
    await handle.close();
  }
}
