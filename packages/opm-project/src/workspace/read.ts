import { constants } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { WorkspaceError } from '@openpacker/adapter-core';
import { openChild } from '@openpacker/project-io';

export function isErrno(error: Error): error is NodeJS.ErrnoException {
  return 'code' in error;
}

/** The errno code of a failure, or `undefined` for one that has none. */
export function errnoOf(error: Error): string | undefined {
  return isErrno(error) ? error.code : undefined;
}

const DECODER_OPTIONS = { fatal: true, ignoreBOM: true } as const;

/**
 * A regular file named `name` in the open directory `parent`, read whole and
 * decoded as UTF-8, or `undefined` when there is no such file.
 *
 * The directory is a handle, the name is opened without following a link, the
 * size is checked before a byte is read and again after, and a file that is a
 * link, a directory, a device, larger than `maximumBytes`, or changed while it
 * was read is refused by name. Nothing reads past the bound.
 *
 * `open` is how the file is opened; only tests pass another, to change the
 * file between the two times it is measured.
 */
export async function readBoundedText(
  parent: FileHandle,
  name: string,
  maximumBytes: number,
  display: string,
  open: typeof openChild = openChild,
): Promise<string | undefined> {
  let file: FileHandle;
  try {
    file = await open(
      parent,
      name,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
  } catch (error) {
    const code = error instanceof Error ? errnoOf(error) : undefined;
    if (code === 'ENOENT') return undefined;
    if (code === 'ELOOP')
      throw new WorkspaceError(
        'WORKSPACE_SYMLINK',
        `${display} is a symbolic link; workspace files are read only where they are, never through a link`,
        [display],
      );
    if (code === 'ENOTDIR' || code === 'EISDIR')
      throw new WorkspaceError(
        'WORKSPACE_MANIFEST_INVALID',
        `${display} is not a regular file`,
        [display],
      );
    throw error;
  }
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile())
      throw new WorkspaceError(
        'WORKSPACE_MANIFEST_INVALID',
        `${display} is not a regular file`,
        [display],
      );
    if (before.size > BigInt(maximumBytes))
      throw new WorkspaceError(
        'WORKSPACE_LIMIT_EXCEEDED',
        `${display} is ${before.size} bytes, more than the limit of ${maximumBytes}`,
        [display],
      );
    const buffer = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < buffer.byteLength) {
      const { bytesRead } = await file.read(
        buffer,
        offset,
        buffer.byteLength - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = await file.stat({ bigint: true });
    if (
      BigInt(offset) !== before.size ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs
    )
      throw new WorkspaceError(
        'WORKSPACE_MANIFEST_INVALID',
        `${display} changed while it was read`,
        [display],
      );
    try {
      return new TextDecoder('utf-8', DECODER_OPTIONS).decode(buffer);
    } catch {
      throw new WorkspaceError(
        'WORKSPACE_MANIFEST_INVALID',
        `${display} is not valid UTF-8`,
        [display],
      );
    }
  } finally {
    await file.close();
  }
}

/**
 * Whether `name` exists in `parent` as anything at all, a link included,
 * without reading it.
 */
export async function entryExists(
  parent: FileHandle,
  name: string,
): Promise<boolean> {
  try {
    const file = await openChild(
      parent,
      name,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
    await file.close();
    return true;
  } catch (error) {
    const code = error instanceof Error ? errnoOf(error) : undefined;
    if (code === 'ENOENT') return false;
    if (code === 'ELOOP') return true;
    throw error;
  }
}
