/**
 * `opm gc --shared` and the integrity index (`by-integrity/<key>`, which names
 * the entry an integrity value's archive was published as).
 *
 * A collection that removes an entry removes the records that name it, and a
 * record an older collection left behind (one whose entry is gone) is removed
 * by the next one: a record never outlives its entry. A record an install
 * reads after all is a miss, which costs a download and nothing else.
 */

import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectSharedStore } from '../src/index.js';
import { INTEGRITY_INDEX } from '../src/shared-store-index.js';
import { cleanupWorlds, world } from './gc-race-fixture.js';

afterEach(cleanupWorlds);

const ENTRY = /^sha256-[0-9a-f]{64}$/u;

async function entries(store: string): Promise<string[]> {
  return (await readdir(store)).filter((name) => ENTRY.test(name)).sort();
}

async function records(store: string): Promise<string[]> {
  return (await readdir(join(store, INTEGRITY_INDEX)).catch(() => [])).sort();
}

/** What an older `opm gc --shared` did: the entries and their `.tree` records gone, the index left. */
async function collectLikeAnOlderGc(store: string): Promise<void> {
  for (const key of await entries(store)) {
    await rm(join(store, key), { recursive: true, force: true });
    await rm(join(store, `${key}.tree`), { force: true });
  }
}

describe('opm gc --shared and the integrity index', () => {
  it('removes the records of each entry it collects, and says so on a dry run first', async () => {
    const w = await world(1);
    await w.install(0);
    await w.unlink(0);
    const named = await records(w.store);
    expect(named).toHaveLength(2);

    const dry = await collectSharedStore({
      env: w.env,
      minimumAgeMs: 0,
      dryRun: true,
    });
    expect(dry.records.sort()).toEqual(
      named.map((name) => join(w.store, INTEGRITY_INDEX, name)).sort(),
    );
    expect(await records(w.store)).toEqual(named);

    const done = await collectSharedStore({ env: w.env, minimumAgeMs: 0 });
    expect(done.removed).toHaveLength(2);
    expect(done.records).toHaveLength(2);
    expect(await entries(w.store)).toEqual([]);
    expect(await records(w.store)).toEqual([]);
  });

  it('removes the records an older collection left without their entry, and keeps the rest', async () => {
    const w = await world(2);
    await w.install(0);
    await w.unlink(0);
    await collectLikeAnOlderGc(w.store);
    const dangling = await records(w.store);
    expect(dangling).toHaveLength(2);
    expect(await entries(w.store)).toEqual([]);
    // A malformed record names nothing either.
    await writeFile(
      join(w.store, INTEGRITY_INDEX, `sha512-${'ab'.repeat(64)}`),
      'not a digest\n',
    );
    // A record whose entry is being published right now is that install's.
    const busy = `sha256-${'cd'.repeat(32)}`;
    await writeFile(
      join(w.store, INTEGRITY_INDEX, `sha512-${'ef'.repeat(64)}`),
      `sha256:${'cd'.repeat(32)}\n`,
    );
    await mkdir(join(w.store, `.${busy}.materialize-1`));

    // Project 1 links the store again: its records name live entries.
    await w.install(1);
    const live = await records(w.store);
    expect(live).toHaveLength(4);

    // The default age, so the publish under way (young) is not taken for a dead one.
    const done = await collectSharedStore({ env: w.env });
    expect(done.removed).toEqual([]);
    expect(done.records.sort()).toEqual(
      [`sha512-${'ab'.repeat(64)}`].map((name) =>
        join(w.store, INTEGRITY_INDEX, name),
      ),
    );
    expect(await records(w.store)).toEqual(
      live.filter((name) => name !== `sha512-${'ab'.repeat(64)}`),
    );
    expect(await entries(w.store)).toHaveLength(2);
  });

  it('cleans a store whose index an older collection left dangling in one pass', async () => {
    const w = await world(1);
    await w.install(0);
    await w.unlink(0);
    await collectLikeAnOlderGc(w.store);
    expect(await records(w.store)).toHaveLength(2);

    const done = await collectSharedStore({ env: w.env, minimumAgeMs: 0 });
    expect(done.records).toHaveLength(2);
    expect(await records(w.store)).toEqual([]);
    expect(
      (await collectSharedStore({ env: w.env, minimumAgeMs: 0 })).records,
    ).toEqual([]);
  });

  it('reads a dangling record as a miss: the install fetches the archive again', async () => {
    const w = await world(1);
    await w.install(0);
    await w.unlink(0);
    await collectLikeAnOlderGc(w.store);
    expect(await records(w.store)).toHaveLength(2);

    const again = await w.install(0);
    expect(again).toMatchObject({ fromStore: 0, fetched: 2 });
    expect(w.require(0, 'a')).toBe('a@1.0.0');
    expect(w.require(0, 'b')).toBe('b@1.0.0');
    expect(await entries(w.store)).toHaveLength(2);
    expect(await records(w.store)).toHaveLength(2);
  });
});
