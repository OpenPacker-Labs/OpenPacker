/**
 * Leases judged by who made them and where: by a pid now reused, by another
 * machine sharing the store, by this machine in another boot, in another pid
 * namespace, by a process that cannot read its own, and on a filesystem that
 * cannot lock.
 *
 * The forged leases are named from what this machine says of this process
 * (`lease-fixture.ts`), not from the module under test.
 */

import { mkdir, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectSharedStore } from '../src/index.js';
import { leaseHeld } from '../src/store-lease-liveness.js';
import {
  leaseDirectory,
  openLease,
  parseLeaseName,
} from '../src/store-lease.js';
import { cleanupWorlds, scratch, storeWithEntry } from './gc-race-fixture.js';
import { LINUX, endedPid, forged, leaseId, me } from './lease-fixture.js';

afterEach(cleanupWorlds);

/** Collect, dry and then for real; both must agree. */
async function collectTwice(env: { OPM_STORE_HOME: string }) {
  const dry = await collectSharedStore({ env, minimumAgeMs: 0, dryRun: true });
  const real = await collectSharedStore({ env, minimumAgeMs: 0 });
  return { dry, real };
}

describe.runIf(LINUX)('a lease on the store', () => {
  it('is abandoned when its pid runs but does not hold the lock open', async () => {
    const { env, store, key } = await storeWithEntry();
    // This process runs and has no descriptor on the forged lock: the case
    // of a pid reused after the holder died.
    await forged(store, leaseId('proc', await me()), key);

    const result = await collectSharedStore({ env, minimumAgeMs: 0 });

    expect(result).toMatchObject({ removed: [join(store, key)], held: 0 });
    expect(await readdir(store)).not.toContain('.leases');
  });

  it('is abandoned when its pid runs but started after the lease was made', async () => {
    const { env, store, key } = await storeWithEntry();
    // `pid`: this process has the pid and runs, but started at another time.
    await forged(store, leaseId('pid', { ...(await me()), start: '1' }), key);

    const result = await collectSharedStore({ env, minimumAgeMs: 0 });

    expect(result).toMatchObject({ removed: [join(store, key)], held: 0 });
    expect(await readdir(store)).not.toContain('.leases');
  });

  it('is held when it names another pid namespace, which this process cannot see', async () => {
    const { env, store, key } = await storeWithEntry();
    const owner = { ...(await me()), pid: endedPid(), namespace: '1' };
    await forged(store, leaseId('proc', owner), key);

    const { dry, real } = await collectTwice(env);

    expect(dry).toMatchObject({ removed: [], held: 1 });
    expect(real).toMatchObject({ removed: [], held: 1 });
  });

  it("is held when another machine sharing the store made it, whatever this machine's /proc says", async () => {
    const { env, store, key } = await storeWithEntry();
    // This process's pid, start and namespace, and it does not hold the
    // lock: judged by this machine's /proc it would be abandoned.
    const id = leaseId('proc', { ...(await me()), machine: 'f'.repeat(32) });
    await forged(store, id, key);

    const { dry, real } = await collectTwice(env);

    expect(dry).toMatchObject({ removed: [], held: 1 });
    expect(real).toMatchObject({ removed: [], held: 1 });
    expect(await readdir(leaseDirectory(store))).toEqual([
      `${id}.keys`,
      `${id}.lock`,
    ]);
  });

  it('is abandoned when this machine made it in a boot that has ended, though its pid runs now', async () => {
    const { env, store, key } = await storeWithEntry();
    // This machine's id and host name, another boot: judged by this boot's
    // processes it would be held (`pid`, and this process has the pid).
    const owner = { ...(await me()), boot: 'e'.repeat(32) };
    await forged(store, leaseId('pid', owner), key);

    const result = await collectSharedStore({ env, minimumAgeMs: 0 });

    expect(result).toMatchObject({ removed: [join(store, key)], held: 0 });
    expect(await readdir(store)).not.toContain('.leases');
  });

  it('is held when it names another boot under this machine id but another host name, which may be a clone of this machine', async () => {
    const { env, store, key } = await storeWithEntry();
    const owner = {
      ...(await me()),
      pid: endedPid(),
      host: 'c'.repeat(16),
      boot: 'e'.repeat(32),
    };
    await forged(store, leaseId('pid', owner), key);

    const { dry, real } = await collectTwice(env);

    expect(dry).toMatchObject({ removed: [], held: 1 });
    expect(real).toMatchObject({ removed: [], held: 1 });
  });

  it('is held when the reader cannot read its own pid namespace', async () => {
    const { store, key } = await storeWithEntry();
    const reader = { ...(await me()), namespace: '0' };
    // A lease from a process that could not read its namespace either, whose
    // pid no process has here: but `0` on both sides says nothing.
    const id = leaseId('pid', { ...reader, pid: endedPid() });
    await forged(store, id, key);

    const held = await leaseHeld(
      leaseDirectory(store),
      parseLeaseName(`${id}.lock`)!,
      { reader },
    );

    expect(held).toBe(true);
  });
});

describe('a lease on a filesystem that cannot lock', () => {
  it('falls back to the pid when O_EXLOCK is refused as unsupported', async () => {
    const directory = leaseDirectory(await scratch('opm-lease-flock-'));
    await mkdir(directory);
    const refused: number[] = [];
    const lease = await openLease(directory, 'install', {
      how: 'flock',
      open: async (path, flags, mode) => {
        if (typeof flags === 'number' && (flags & 0x20) !== 0) {
          refused.push(flags);
          throw Object.assign(new Error('flock: not supported'), {
            code: 'ENOTSUP',
          });
        }
        return open(path, flags, mode);
      },
    });

    expect(refused).toHaveLength(1);
    expect(lease.id).toMatch(/^install\.pid\./u);
    expect(await readdir(directory)).toEqual(
      [`${lease.id}.keys`, `${lease.id}.lock`].sort(),
    );
    await lease.release();
  });
});

describe('a lease on a disk that fills up', () => {
  it('fails the write that its keys file takes only part of, and every write after it', async () => {
    const directory = leaseDirectory(await scratch('opm-lease-short-'));
    await mkdir(directory);
    const lease = await openLease(directory, 'install', {
      // The keys file takes all but the last three bytes of each write.
      open: async (path, flags, mode) => {
        const handle = await open(path, flags, mode);
        if (!String(path).endsWith('.keys')) return handle;
        const write = handle.write.bind(handle);
        return Object.assign(handle, {
          write: async (data: Uint8Array) =>
            write(Buffer.from(data).subarray(0, data.length - 3)),
        });
      },
    });
    const key = `sha256-${'a'.repeat(64)}`;

    await expect(lease.write(key)).rejects.toThrow(/took 69 of 72 bytes/u);
    await expect(lease.write(key)).rejects.toThrow(/took 69 of 72 bytes/u);
    await lease.release();
  });
});
