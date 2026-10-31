/**
 * Reading the two files a frozen install starts from: no-follow, regular files
 * only, bounded. A lock or a manifest that is a symbolic link, is not a file or
 * is larger than the bound is refused rather than read.
 */

import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { ProviderError } from '@openpacker/adapter-core';

export const MAXIMUM_LOCK_BYTES = 64 * 1024 * 1024;
export const MAXIMUM_MANIFEST_BYTES = 4 * 1024 * 1024;

export async function readBoundedBytes(
  path: string,
  maximum: number,
): Promise<Buffer> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    // SAFETY: Node file errors carry a string `code`.
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT')
      throw new ProviderError('NOT_FOUND', `${path} does not exist`);
    if (code === 'ELOOP')
      throw new ProviderError(
        'UNSAFE_PATH',
        `${path} is a symbolic link; a frozen install reads the file itself`,
      );
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile())
      throw new ProviderError(
        'INVALID_LOCKFILE',
        `${path} is not a regular file`,
      );
    if (info.size > maximum)
      throw new ProviderError(
        'INVALID_LOCKFILE',
        `${path} is ${info.size} bytes, more than the ${maximum} this reads`,
      );
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

export async function readBounded(
  path: string,
  maximum: number,
): Promise<string> {
  return (await readBoundedBytes(path, maximum)).toString('utf8');
}
