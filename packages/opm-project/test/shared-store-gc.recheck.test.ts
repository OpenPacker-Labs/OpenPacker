/**
 * The collection's looks at an entry. The first, before it announces
 * anything, and the second, after it announced the entry and found no claim:
 * an entry another collection removed first is counted nowhere, and anything
 * the second look cannot make out keeps the entry.
 */

import { readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { removeStableTree } from '../src/paths.js';
import { collectSharedStoreWith } from '../src/shared-store-gc.js';
import { cleanupWorlds, storeWithEntry, world } from './gc-race-fixture.js';

afterEach(cleanupWorlds);

describe("a collection's second look at an entry", () => {
  it('keeps an entry it cannot look through, as it keeps anything unclear', async () => {
    const { env, store, key } = await storeWithEntry();
    const entry = join(store, key);
    const collected = await collectSharedStoreWith(
      { env, minimumAgeMs: 0 },
      {
        // Between the first look and the second, the entry stops being a
        // directory it can read.
        step: async (step) => {
          if (step !== 'gc-announced') return;
          await rename(entry, `${entry}.moved`);
          await writeFile(entry, 'not an entry');
        },
      },
    );

    expect(collected).toMatchObject({ removed: [], held: 1 });
    expect(await readdir(store)).toContain(key);
    await removeStableTree(`${entry}.moved`);
  });

  it('does not count an entry another collection removed first', async () => {
    const { env, store, key } = await storeWithEntry();
    const entry = join(store, key);
    const collected = await collectSharedStoreWith(
      { env, minimumAgeMs: 0 },
      {
        step: async (step) => {
          if (step !== 'gc-announced') return;
          await rename(entry, join(store, `.${key}.collect-other`));
        },
      },
    );

    expect(collected).toMatchObject({ removed: [], held: 0, referenced: 0 });
  });
});

describe("a collection's first look at an entry", () => {
  it('goes on when another collection removed the entry before it', async () => {
    const w = await world(1);
    await w.install(0);
    await w.unlink(0);
    const entries = async () =>
      (await readdir(w.store)).filter((name) =>
        /^sha256-[0-9a-f]{64}$/u.test(name),
      );
    expect(await entries()).toHaveLength(2);
    let inner: Awaited<ReturnType<typeof collectSharedStoreWith>> | undefined;

    const outer = await collectSharedStoreWith(
      { env: w.env, minimumAgeMs: 0 },
      {
        // The outer collection has decided on its first entry. A whole second
        // collection now runs, and removes both before the outer looks at the
        // second for the first time.
        beforeCollecting: async () => {
          inner ??= await collectSharedStoreWith(
            { env: w.env, minimumAgeMs: 0 },
            {},
          );
        },
      },
    );

    expect(inner?.removed).toHaveLength(2);
    expect(outer).toMatchObject({
      removed: [],
      referenced: 0,
      tooNew: 0,
      held: 0,
    });
    expect(await entries()).toEqual([]);
  });
});
