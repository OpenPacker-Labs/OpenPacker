/**
 * What a failed extraction is called. An error from the machine (a full or
 * read-only disk, a store the user may not write, a process out of
 * descriptors or memory) is said as it is and is not the archive's fault;
 * any other failure of the archive's extraction is an unsafe path, which is
 * how it was reported before the machine's errors were told apart.
 */

import { createHash } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isEnvironmentalError } from '../src/frozen-store.js';
import { storeKeyFromDigest } from '../src/index.js';
import { cleanupWorlds, world } from './gc-race-fixture.js';

afterEach(cleanupWorlds);

function failure(code: string, syscall: string | null = 'write') {
  return Object.assign(new Error(`${code}: failed, ${syscall}`), {
    code,
    ...(syscall !== null && { syscall }),
  });
}

describe('an error from extracting an archive', () => {
  it.each([
    'ENOSPC',
    'EDQUOT',
    'EROFS',
    'EACCES',
    'EPERM',
    'EIO',
    'EMFILE',
    'ENFILE',
    'ENOMEM',
  ])('is the machine’s when it is %s', (code) => {
    expect(isEnvironmentalError(failure(code))).toBe(true);
  });

  it.each([
    'EISDIR',
    'ENOTDIR',
    'ENAMETOOLONG',
    'ELOOP',
    'EEXIST',
    'ENOENT',
    'EINVAL',
    'EMLINK',
  ])('is not when it is %s, which an archive can cause', (code) => {
    expect(isEnvironmentalError(failure(code))).toBe(false);
  });

  it('is not when it is no failed system call', () => {
    expect(isEnvironmentalError(failure('ENOSPC', null))).toBe(false);
    expect(isEnvironmentalError(new Error('ENOSPC'))).toBe(false);
    expect(isEnvironmentalError(undefined)).toBe(false);
    expect(isEnvironmentalError('ENOSPC')).toBe(false);
  });

  it('is an unsafe path when the system call that failed is not the machine’s', async () => {
    const w = await world(2);
    await w.install(0);
    const [, bytes] = [...w.registry.archives][0]!;
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    const key = storeKeyFromDigest(digest);
    await w.unlink(0);
    // The entry is gone and its record is in the way: writing the record
    // fails with EISDIR, a failed rename and not a full disk.
    await rm(join(w.store, key), { recursive: true });
    await rm(join(w.store, `${key}.tree`));
    await mkdir(join(w.store, `${key}.tree`));

    await expect(w.install(1)).rejects.toMatchObject({
      code: 'UNSAFE_PATH',
      message: expect.stringMatching(/cannot be extracted: EISDIR/u),
    });
  });
});
