/**
 * `opm ci` while `opm gc --shared` runs against the same store.
 *
 * Each test runs the collection inside the install, between "the archive is in
 * the store" and "node_modules links it" (the `beforeLayout` seam of
 * `installFrozenWith`), with nothing but promises deciding the order, and no
 * grace period (`minimumAgeMs: 0`): an entry nothing links yet is exactly what
 * a collection removes, unless the install's claim on it stops it.
 */

import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { packTarGzip } from '@openpacker/project-io';
import { afterEach, describe, expect, it } from 'vitest';
import {
  collectSharedStore,
  type SharedStoreCollection,
} from '../src/index.js';
import { collectSharedStoreWith } from '../src/shared-store-gc.js';
import { cleanupWorlds, signal, world } from './gc-race-fixture.js';

afterEach(cleanupWorlds);

async function entries(store: string): Promise<string[]> {
  return (await readdir(store)).filter((name) =>
    /^sha256-[0-9a-f]{64}$/u.test(name),
  );
}

describe('opm ci and opm gc --shared at once', () => {
  it('keeps an entry it found in the store until it is linked', async () => {
    const w = await world(1);
    await w.install(0);
    await w.unlink(0);
    const before = await entries(w.store);
    expect(before).toHaveLength(2);

    let collected: SharedStoreCollection | undefined;
    const result = await w.install(
      0,
      { offline: true },
      {
        beforeLayout: async () => {
          collected = await collectSharedStore({
            env: w.env,
            minimumAgeMs: 0,
          });
        },
      },
    );

    expect(result).toMatchObject({ fromStore: 2, fetched: 0 });
    expect(collected).toMatchObject({ removed: [], held: 2 });
    expect(w.require(0, 'a')).toBe('a@1.0.0');
    expect(w.require(0, 'b')).toBe('b@1.0.0');
    expect(await entries(w.store)).toEqual(before);
  });

  it('keeps an entry it has just published until it is linked', async () => {
    const w = await world(1);
    let collected: SharedStoreCollection | undefined;
    const result = await w.install(
      0,
      {},
      {
        beforeLayout: async () => {
          collected = await collectSharedStore({
            env: w.env,
            minimumAgeMs: 0,
          });
        },
      },
    );

    expect(result).toMatchObject({ fromStore: 0, fetched: 2 });
    expect(collected).toMatchObject({ removed: [], held: 2 });
    expect(w.require(0, 'a')).toBe('a@1.0.0');
  });

  it('lets two installs use the store at once, and a collection between them takes nothing', async () => {
    const w = await world(2);
    await w.install(0);
    await w.unlink(0);
    // Both installs wait here until both have arrived: if a claim excluded
    // another claim, the second would never arrive and the test would time out.
    const both = signal();
    const go = signal();
    let arrived = 0;
    const beforeLayout = async (): Promise<void> => {
      arrived += 1;
      if (arrived === 2) both.fire();
      await go.done;
    };
    const installs = [
      w.install(0, { offline: true }, { beforeLayout }),
      w.install(1, { offline: true }, { beforeLayout }),
    ];
    await both.done;
    const collected = await collectSharedStore({
      env: w.env,
      minimumAgeMs: 0,
    });
    go.fire();
    const results = await Promise.all(installs);

    expect(collected).toMatchObject({ removed: [], held: 2 });
    for (const result of results)
      expect(result).toMatchObject({ fromStore: 2, fetched: 0 });
    for (const index of [0, 1]) {
      expect(w.require(index, 'a')).toBe('a@1.0.0');
      expect(w.require(index, 'b')).toBe('b@1.0.0');
    }
    // Linked now, by both projects: still not collectable.
    expect(
      await collectSharedStore({ env: w.env, minimumAgeMs: 0 }),
    ).toMatchObject({ removed: [], referenced: 2, held: 0 });
  });

  it('leaves an entry an install linked after the collection first looked at it', async () => {
    const w = await world(1);
    await w.install(0);
    await w.unlink(0);
    let installed = false;
    // The whole install, claims, links and release, happens between the
    // collection finding the entry unlinked and deciding on it.
    const collected = await collectSharedStoreWith(
      { env: w.env, minimumAgeMs: 0 },
      {
        beforeCollecting: async () => {
          if (installed) return;
          installed = true;
          await w.install(0, { offline: true });
        },
      },
    );

    expect(collected).toMatchObject({ removed: [], held: 0 });
    expect(collected.referenced).toBeGreaterThanOrEqual(1);
    expect(w.require(0, 'a')).toBe('a@1.0.0');
    expect(await entries(w.store)).toHaveLength(2);
  });

  it('collects the entries once the installs that used them are gone', async () => {
    const w = await world(1);
    await w.install(0);
    await w.unlink(0);
    const collected = await collectSharedStore({
      env: w.env,
      minimumAgeMs: 0,
    });
    expect(collected).toMatchObject({ held: 0 });
    expect(collected.removed).toHaveLength(2);
    expect(await entries(w.store)).toEqual([]);
    // And nothing of the claims is left behind.
    expect(await readdir(w.store)).not.toContain('.leases');
  });
});

describe('the seams these tests use', () => {
  it('are not part of the package: installFrozen and collectSharedStore run none they are handed', async () => {
    const api = await import('../src/index.js');
    expect(api).not.toHaveProperty('installFrozenWith');
    expect(api).not.toHaveProperty('collectSharedStoreWith');
    const w = await world(1);
    const ran: string[] = [];
    // Smuggled past the input types, as a host passing an object could.
    const install = {
      offline: false,
      beforeLayout: async () => {
        ran.push('beforeLayout');
      },
    };
    await w.install(0, install);
    await w.unlink(0);
    const collection = {
      env: w.env,
      minimumAgeMs: 0,
      beforeCollecting: async () => {
        ran.push('beforeCollecting');
      },
    };
    await collectSharedStore(collection);
    expect(ran).toEqual([]);
  });
});

describe('an entry that vanishes anyway', () => {
  // A remover that does not honour claims (an older opm, or a person) can
  // still take an entry; the install puts it back from its archive, once.
  it('is fetched again and linked, and the store holds it again', async () => {
    const w = await world(1);
    await w.install(0);
    await w.unlink(0);
    const before = await entries(w.store);
    const requests = w.registry.requests.length;

    const result = await w.install(
      0,
      {},
      {
        beforeLayout: async () => {
          await rm(join(w.store, before[0]!), { recursive: true, force: true });
        },
      },
    );

    expect(result).toMatchObject({ fromStore: 2 });
    expect(w.registry.requests).toHaveLength(requests + 1);
    expect(w.require(0, 'a')).toBe('a@1.0.0');
    expect(w.require(0, 'b')).toBe('b@1.0.0');
    expect(await entries(w.store)).toEqual(before);
  });

  it('fails naming the entry when it cannot be fetched again', async () => {
    const w = await world(1);
    await w.install(0);
    await w.unlink(0);
    const [gone] = await entries(w.store);

    await expect(
      w.install(
        0,
        { offline: true },
        {
          beforeLayout: async () => {
            await rm(join(w.store, gone!), { recursive: true, force: true });
          },
        },
      ),
    ).rejects.toMatchObject({
      code: 'STORE_ENTRY_VANISHED',
      message: expect.stringContaining(join(w.store, gone!)),
    });
  });
  it('fails as a verification failure, not as unavailable, when what is fetched again is not what the lock pins', async () => {
    const w = await world(1);
    await w.install(0);
    await w.unlink(0);
    const gone = await entries(w.store);
    // The registry now serves other bytes for every archive.
    for (const url of w.registry.archives.keys())
      w.registry.archives.set(
        url,
        packTarGzip([
          {
            path: 'package/index.js',
            contents: new TextEncoder().encode('module.exports = 0;\n'),
          },
        ]),
      );

    await expect(
      w.install(
        0,
        {},
        {
          beforeLayout: async () => {
            for (const name of gone)
              await rm(join(w.store, name), { recursive: true, force: true });
          },
        },
      ),
    ).rejects.toMatchObject({
      code: 'DIGEST_MISMATCH',
      message: expect.stringMatching(
        /removed while this install was linking from the store, and could not be put back: .*does not match the integrity the lock pins/u,
      ),
    });
  });
});
