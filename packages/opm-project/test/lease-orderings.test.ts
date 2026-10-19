/**
 * The orderings the lease protocol rests on, each forced on the real code.
 *
 * Every test stops one side at a step between a write to `.leases` and the
 * read that must come after it (`LeaseStep`), runs the other side there, and
 * checks the outcome the order guarantees. Reversing either order makes the
 * test fail; nothing here depends on timing.
 */

import { readdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { collectSharedStore } from '../src/index.js';
import { removeStableFile, removeStableTree } from '../src/paths.js';
import { adoptSharedEntry } from '../src/shared-store.js';
import { collectSharedStoreWith } from '../src/shared-store-gc.js';
import { holdSharedStore, openCollection } from '../src/shared-store-lease.js';
import { leaseDirectory } from '../src/store-lease.js';
import {
  cleanupWorlds,
  signal,
  storeWithEntry,
  world,
} from './gc-race-fixture.js';

afterEach(cleanupWorlds);

describe('a lease being made', () => {
  it("is not judged abandoned by a collection's sweep that looks while its lock is renamed", async () => {
    const { env, store, key } = await storeWithEntry();
    const opened = signal();
    const judged = signal();
    const claimed = signal();
    let install: string | undefined;
    // The install's first claim makes its lease, and stops with the lock
    // open as `.pending`, not yet renamed.
    const hold = await holdSharedStore(store, {
      step: async (step, id) => {
        if (step !== 'lease-opened') return;
        install = id;
        opened.fire();
        await judged.done;
      },
    });
    const claiming = hold.claim(key);
    await opened.done;
    // The collection's sweep judges one of the lease's two names, and then
    // the install renames its lock and claims the entry before the sweep
    // judges the other one.
    let first = true;
    const collecting = collectSharedStoreWith(
      { env, minimumAgeMs: 0 },
      {
        step: async (step, id) => {
          if (step !== 'lease-judged' || id !== install || !first) return;
          first = false;
          judged.fire();
          await claimed.done;
        },
      },
    );
    await claiming;
    claimed.fire();
    const collected = await collecting;

    expect(collected).toMatchObject({ removed: [], held: 1 });
    expect(await readdir(store)).toContain(key);
    expect(await readdir(leaseDirectory(store))).toEqual([
      `${install}.keys`,
      `${install}.lock`,
    ]);
    await hold.release();
  });
});

describe('an install and a collection deciding on one entry', () => {
  it('a collection announces before it reads the claims: an install that claims between the two waits, and the collection sees its claim', async () => {
    const { env, store, key } = await storeWithEntry();
    const waiting = signal();
    let claiming: Promise<void> | undefined;
    const collected = await collectSharedStoreWith(
      { env, minimumAgeMs: 0 },
      {
        step: async (step) => {
          if (step !== 'gc-announced' || claiming !== undefined) return;
          const hold = await holdSharedStore(store, {
            pause: async () => {
              waiting.fire();
              await sleep(5);
            },
          });
          claiming = hold.claim(key).finally(() => hold.release());
          // The claim is written, and it either waits on the announcement
          // or, had nothing been announced yet, is done looking.
          await Promise.race([waiting.done, claiming]);
        },
      },
    );
    await claiming;

    expect(collected).toMatchObject({ removed: [], held: 1 });
    expect(await readdir(store)).toContain(key);
  });

  it('an install claims before it reads the announcements: a collection that runs between the two leaves the entry', async () => {
    const { env, store, key } = await storeWithEntry();
    let collected: unknown;
    const hold = await holdSharedStore(store, {
      step: async (step) => {
        if (step !== 'install-claimed' || collected !== undefined) return;
        collected = await collectSharedStore({ env, minimumAgeMs: 0 });
      },
    });

    await hold.claim(key);

    expect(collected).toMatchObject({ removed: [], held: 1 });
    expect(await adoptSharedEntry(store, `sha256:${key.slice(7)}`)).toEqual({
      path: join(store, key),
      treeDigest: expect.stringMatching(/^sha256:/u),
    });
    await hold.release();
  });

  it('a collection settles an entry only once it is unpublished: an install that looks as soon as it is settled finds nothing to adopt', async () => {
    const { env, store, key } = await storeWithEntry();
    let found: unknown = 'not looked';
    const collected = await collectSharedStoreWith(
      { env, minimumAgeMs: 0 },
      {
        step: async (step) => {
          if (step !== 'gc-settled' || found !== 'not looked') return;
          const hold = await holdSharedStore(store);
          await hold.claim(key);
          found = await adoptSharedEntry(store, `sha256:${key.slice(7)}`);
          await hold.release();
        },
      },
    );

    expect(collected.removed).toEqual([join(store, key)]);
    expect(found).toBeUndefined();
  });
});

describe('opm ci and a collection deciding on its entries', () => {
  it('claims an entry before it looks it up: an entry a collection announced and then removes is not adopted', async () => {
    const w = await world(1);
    await w.install(0);
    await w.unlink(0);
    const keys = (await readdir(w.store)).filter((name) =>
      /^sha256-[0-9a-f]{64}$/u.test(name),
    );
    // A collection has announced every entry and found no claim on any.
    const collection = await openCollection(w.store, false);
    for (const key of keys) expect(await collection.claimed(key)).toBe(false);
    let unpublished = false;
    const installing = w.install(
      0,
      { offline: true },
      {
        hold: {
          // The install waits on the announcements; meanwhile the collection
          // unpublishes the entries, as it does, and settles them.
          pause: async () => {
            if (!unpublished) {
              unpublished = true;
              for (const key of keys) {
                const doomed = join(w.store, `.${key}.collect-test`);
                await rename(join(w.store, key), doomed);
                await removeStableFile(join(w.store, `${key}.tree`));
                await collection.settled(key);
                await removeStableTree(doomed);
              }
            }
            await sleep(1);
          },
        },
      },
    );

    // Not adopted and then found gone after the layout (STORE_ENTRY_VANISHED):
    // looked up after the wait, and so not there to install offline.
    await expect(installing).rejects.toMatchObject({
      code: 'OFFLINE',
      message: expect.stringContaining('a@1.0.0'),
    });
    await collection.release();
  });
});
