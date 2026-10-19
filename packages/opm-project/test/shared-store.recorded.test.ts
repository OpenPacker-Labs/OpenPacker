/**
 * An entry the store holds without the digest its tree must hash to, or with
 * a tree that no longer hashes to it: adopting it fails, and says what to
 * remove. The first is what an install leaves that publishes in the few
 * milliseconds between a collection's rename of the entry and its removal of
 * the entry's record, after it gave up waiting for that collection (45 s).
 */

import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { adoptSharedEntry } from '../src/shared-store.js';
import { cleanupWorlds, storeWithEntry } from './gc-race-fixture.js';

afterEach(cleanupWorlds);

describe('adopting an entry the store cannot vouch for', () => {
  it('names the entry to remove when its tree digest is missing', async () => {
    const { store, key } = await storeWithEntry();
    await rm(join(store, `${key}.tree`));

    const adopting = adoptSharedEntry(
      store,
      `sha256:${key.slice('sha256-'.length)}`,
    );

    await expect(adopting).rejects.toMatchObject({
      code: 'VERIFICATION_FAILED',
      message: `Shared store entry is missing its tree digest: ${join(store, key)}; remove ${join(store, key)} and run the command again`,
    });
  });

  it('adopts the same entry when its tree digest is there', async () => {
    const { store, key } = await storeWithEntry();

    const adopted = await adoptSharedEntry(
      store,
      `sha256:${key.slice('sha256-'.length)}`,
    );

    expect(adopted?.path).toBe(join(store, key));
  });
});
