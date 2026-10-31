/**
 * A lease's name says which machine made it by a keyed digest of the machine
 * id, never by the id: machine-id(5) calls the id confidential, and `.leases`
 * sits in a store that users, containers and machines may share. A lease an
 * earlier opm named by the id itself is still this machine's: honoured while
 * its holder lives, removed once that holder is gone.
 *
 * The forged leases are named from what this machine says of this process
 * (`lease-fixture.ts`), not from the module under test.
 */

import { open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectSharedStore } from '../src/index.js';
import {
  leaseDirectory,
  openLease,
  parseLeaseName,
} from '../src/store-lease.js';
import { cleanupWorlds, scratch, storeWithEntry } from './gc-race-fixture.js';
import {
  LINUX,
  endedPid,
  forged,
  leaseId,
  machineDigest,
  machineId,
  me,
  meByEarlierOpm,
} from './lease-fixture.js';

afterEach(cleanupWorlds);

/** Collect, dry and then for real; both must agree. */
async function collectTwice(env: { OPM_STORE_HOME: string }) {
  const dry = await collectSharedStore({ env, minimumAgeMs: 0, dryRun: true });
  const real = await collectSharedStore({ env, minimumAgeMs: 0 });
  return { dry, real };
}

describe.runIf(LINUX)("a lease's name", () => {
  it('names the machine by a keyed digest of its id, and never by the id', async () => {
    const directory = leaseDirectory(await scratch('opm-lease-machine-'));
    const id = await machineId();
    const lease = await openLease(directory, 'install');
    try {
      const names = await readdir(directory);
      expect(names.length).toBeGreaterThan(0);
      for (const name of names) expect(name).not.toContain(id);
      const owner = parseLeaseName(`${lease.id}.lock`)!.owner;
      expect(owner.machine).toBe(machineDigest(id));
      expect(owner).toEqual(await me());
    } finally {
      await lease.release();
    }
  });
});

describe.runIf(LINUX)('a lease an earlier opm named by the machine id', () => {
  it('is held while its holder has the lock open, and abandoned once it closes it', async () => {
    const { env, store, key } = await storeWithEntry();
    const id = leaseId('proc', await meByEarlierOpm());
    await forged(store, id, key);
    // This process holds the lock, as the earlier opm's install would.
    const lock = await open(join(leaseDirectory(store), `${id}.lock`), 'r');
    try {
      const { dry, real } = await collectTwice(env);
      expect(dry).toMatchObject({ removed: [], held: 1 });
      expect(real).toMatchObject({ removed: [], held: 1 });
    } finally {
      await lock.close();
    }

    const result = await collectSharedStore({ env, minimumAgeMs: 0 });

    expect(result).toMatchObject({ removed: [join(store, key)], held: 0 });
    expect(await readdir(store)).not.toContain('.leases');
  });

  it('is held while its pid runs and started when the holder did', async () => {
    const { env, store, key } = await storeWithEntry();
    await forged(store, leaseId('pid', await meByEarlierOpm()), key);

    const { dry, real } = await collectTwice(env);

    expect(dry).toMatchObject({ removed: [], held: 1 });
    expect(real).toMatchObject({ removed: [], held: 1 });
  });

  it('is abandoned when no process has its pid', async () => {
    const { env, store, key } = await storeWithEntry();
    const owner = { ...(await meByEarlierOpm()), pid: endedPid() };
    await forged(store, leaseId('pid', owner), key);

    const result = await collectSharedStore({ env, minimumAgeMs: 0 });

    expect(result).toMatchObject({ removed: [join(store, key)], held: 0 });
  });

  it('is abandoned when it was made in a boot of this machine that has ended, though its pid runs now', async () => {
    // Only a lease placed on this machine is: one taken for another
    // machine's would be held.
    const { env, store, key } = await storeWithEntry();
    const owner = { ...(await meByEarlierOpm()), boot: 'e'.repeat(32) };
    await forged(store, leaseId('pid', owner), key);

    const result = await collectSharedStore({ env, minimumAgeMs: 0 });

    expect(result).toMatchObject({ removed: [join(store, key)], held: 0 });
  });

  it("is held when it names another machine's id", async () => {
    const { env, store, key } = await storeWithEntry();
    const owner = {
      ...(await meByEarlierOpm()),
      machine: 'f'.repeat(32),
      boot: 'e'.repeat(32),
    };
    await forged(store, leaseId('pid', owner), key);

    const { dry, real } = await collectTwice(env);

    expect(dry).toMatchObject({ removed: [], held: 1 });
    expect(real).toMatchObject({ removed: [], held: 1 });
  });
});
