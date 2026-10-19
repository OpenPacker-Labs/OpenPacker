/**
 * Lease files of the names earlier builds of this change wrote. They are not
 * read: a lease in one of those names neither protects an entry nor exposes
 * one. They are swept once a day old, so that they do not keep the last holder
 * from removing `.leases`. A name of no format this build knows is not its
 * to remove.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readdir, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectSharedStore } from '../src/index.js';
import { holdSharedStore } from '../src/shared-store-lease.js';
import { leaseDirectory, parseLeaseName } from '../src/store-lease.js';
import { cleanupWorlds, storeWithEntry } from './gc-race-fixture.js';

afterEach(cleanupWorlds);

const HOUR = 3_600_000;
const MACHINE = 'a'.repeat(32);
const BOOT = 'b'.repeat(32);

/** `<kind>.<how>.<pid>.<pid namespace>.<uuid>`: the first format. */
const first = () => `install.proc.4242.4026531836.${randomUUID()}`;
/** The same with the start time, machine and boot: the second format. */
const second = () =>
  `gc.pid.4242.1000.4026531836.${MACHINE}.${BOOT}.${randomUUID()}`;

/** Lease files in `store`, last touched `age` ago, and a keys line in each. */
async function leave(
  store: string,
  names: readonly string[],
  age: number,
): Promise<void> {
  const directory = leaseDirectory(store);
  await mkdir(directory, { recursive: true });
  const then = new Date(Date.now() - age);
  for (const name of names) {
    const path = join(directory, name);
    await writeFile(path, name.endsWith('.keys') ? 'sha256-a\n' : '');
    await utimes(path, then, then);
  }
}

describe('lease files in the names of earlier builds', () => {
  it('are not leases', () => {
    for (const id of [first(), second()])
      for (const file of ['lock', 'keys', 'pending'])
        expect(parseLeaseName(`${id}.${file}`)).toBeUndefined();
  });

  it('are swept by a collection once a day old, so that no lease directory is left', async () => {
    const { env, store, key } = await storeWithEntry();
    const a = first();
    const b = second();
    await leave(
      store,
      [`${a}.lock`, `${a}.keys`, `${b}.lock`, `${b}.keys`],
      25 * HOUR,
    );

    const result = await collectSharedStore({ env, minimumAgeMs: 0 });

    expect(result).toMatchObject({ removed: [join(store, key)], held: 0 });
    expect(await readdir(store)).not.toContain('.leases');
  });

  it('are left while younger than that', async () => {
    const { env, store } = await storeWithEntry();
    const a = first();
    await leave(store, [`${a}.lock`, `${a}.keys`], 23 * HOUR);

    await collectSharedStore({ env, minimumAgeMs: 0 });

    expect(await readdir(leaseDirectory(store))).toEqual([
      `${a}.keys`,
      `${a}.lock`,
    ]);
  });

  it('are left by a dry run, which removes nothing', async () => {
    const { env, store } = await storeWithEntry();
    const a = first();
    await leave(store, [`${a}.lock`], 25 * HOUR);

    await collectSharedStore({ env, minimumAgeMs: 0, dryRun: true });

    expect(await readdir(leaseDirectory(store))).toEqual([`${a}.lock`]);
  });

  it('are the only files swept: a name of no known format stays, however old', async () => {
    const { env, store } = await storeWithEntry();
    const names = [
      `install.v9.${randomUUID()}.lock`,
      `notes.txt`,
      `install.proc.4242.4026531836.${randomUUID()}.log`,
    ];
    await leave(store, names, 400 * HOUR);

    await collectSharedStore({ env, minimumAgeMs: 0 });

    expect(await readdir(leaseDirectory(store))).toEqual([...names].sort());
  });

  it('do not protect an entry, and sweeping them does not unprotect one that a live install claimed', async () => {
    const { env, store, key } = await storeWithEntry();
    const a = first();
    await leave(store, [`${a}.lock`, `${a}.keys`], 25 * HOUR);
    const hold = await holdSharedStore(store);
    await hold.claim(key);

    const result = await collectSharedStore({ env, minimumAgeMs: 0 });

    expect(result).toMatchObject({ removed: [], held: 1 });
    expect(await readdir(leaseDirectory(store))).toHaveLength(2);
    await hold.release();
  });
});
