/**
 * What an install does when the store will not let it make a lease: a store
 * it may read and not write (a read-only mount, a root of another owner or
 * mode, an operation the system forbids) gets no lease, and the install goes
 * on and adopts what is there. Any other error fails the claim, a full disk
 * among them: an install that would only adopt still needs its claims written
 * where a collection can see them, and cannot be told it has them when it
 * could not write them.
 */

import { open, readdir } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { holdSharedStore } from '../src/shared-store-lease.js';
import { leaseDirectory } from '../src/store-lease.js';
import { cleanupWorlds, storeWithEntry } from './gc-race-fixture.js';

afterEach(cleanupWorlds);

/** `open` as a file system answers it when it refuses `code`. */
function refusing(code: string): typeof open {
  return async (path) => {
    throw Object.assign(new Error(`${code}: cannot open '${String(path)}'`), {
      code,
    });
  };
}

/** The install's lease files in the store, if the store has any. */
async function leaseFiles(store: string): Promise<string[]> {
  return readdir(leaseDirectory(store)).catch(() => []);
}

describe('an install whose store refuses it a lease', () => {
  it.each(['EROFS', 'EACCES', 'EPERM'])(
    'goes on without one when the store answers %s',
    async (code) => {
      const { store, key } = await storeWithEntry();
      const hold = await holdSharedStore(store, { open: refusing(code) });

      await expect(hold.claim(key)).resolves.toBeUndefined();

      expect(await leaseFiles(store)).toEqual([]);
      await hold.release();
    },
  );

  it.each(['ENOSPC', 'EDQUOT', 'EIO'])(
    'fails the claim when the store answers %s',
    async (code) => {
      const { store, key } = await storeWithEntry();
      const hold = await holdSharedStore(store, { open: refusing(code) });

      await expect(hold.claim(key)).rejects.toMatchObject({ code });

      expect(await leaseFiles(store)).toEqual([]);
      await hold.release();
    },
  );
});
