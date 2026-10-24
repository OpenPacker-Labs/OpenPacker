/**
 * How an install reads the collections' leases: once per hold, each byte of
 * a keys file once, and only whole lines.
 */

import { createHash } from 'node:crypto';
import { appendFile, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { holdSharedStore } from '../src/shared-store-lease.js';
import { leaseDirectory, openLease } from '../src/store-lease.js';
import { cleanupWorlds, storeWithEntry } from './gc-race-fixture.js';

afterEach(cleanupWorlds);

function otherKey(salt: string): string {
  return `sha256-${createHash('sha256').update(salt).digest('hex')}`;
}

/** The keys file of the one `gc` lease in `store`. */
async function gcKeys(store: string): Promise<string> {
  const names = await readdir(leaseDirectory(store));
  return join(
    leaseDirectory(store),
    names.find((name) => name.startsWith('gc.') && name.endsWith('.keys'))!,
  );
}

const never = async (): Promise<void> => {
  throw new Error('the claim waited');
};

describe("an install's hold on the store", () => {
  it('reads a collection lease from where it stopped, not from its first byte, on every claim', async () => {
    const { store, key } = await storeWithEntry();
    const gc = await openLease(leaseDirectory(store), 'gc');
    await gc.write(`+${key}`);
    await gc.write(`-${key}`);
    const hold = await holdSharedStore(store, { pause: never });
    await hold.claim(otherKey('first'));
    // Lines already read are not read again: rewritten in place to announce
    // the entry and never settle it, they change nothing for this hold.
    const keys = await open(await gcKeys(store), 'r+');
    await keys.write(`+${key}\n+${key}\n`, 0);
    await keys.close();

    await hold.claim(key);

    await hold.release();
    await gc.release();
  });

  it('reads each line once however many claims look at once', async () => {
    const { store, key } = await storeWithEntry();
    const gc = await openLease(leaseDirectory(store), 'gc');
    for (let index = 0; index < 50; index += 1) {
      await gc.write(`+${otherKey(`gc ${index}`)}`);
      await gc.write(`-${otherKey(`gc ${index}`)}`);
    }
    const hold = await holdSharedStore(store, { pause: never });
    // Fifty claims look at once: none may take the lines another is reading
    // a second time, and so move past lines nobody has read.
    await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        hold.claim(otherKey(`install ${index}`)),
      ),
    );
    await gc.write(`+${key}`);
    let waited = 0;
    const waiting = await holdSharedStore(store, {
      pause: async () => {
        waited += 1;
        await gc.write(`-${key}`);
      },
    });

    await waiting.claim(key);

    expect(waited).toBe(1);
    await waiting.release();
    await hold.release();
    await gc.release();
  });

  it('takes a line only once it is whole', async () => {
    const { store, key } = await storeWithEntry();
    const gc = await openLease(leaseDirectory(store), 'gc');
    const hold = await holdSharedStore(store, { pause: never });
    // A collection's announcement, half appended when a claim looks.
    await appendFile(await gcKeys(store), `+${key.slice(0, 30)}`);
    await hold.claim(otherKey('first'));
    await appendFile(await gcKeys(store), `${key.slice(30)}\n`);
    let waited = 0;
    const waiting = await holdSharedStore(store, {
      pause: async () => {
        waited += 1;
        await gc.write(`-${key}`);
      },
    });

    await waiting.claim(key);

    expect(waited).toBe(1);
    await waiting.release();
    await hold.release();
    await gc.release();
  });
});
