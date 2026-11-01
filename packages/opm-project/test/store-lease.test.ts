/**
 * Leases on the shared store: held while their holder runs, abandoned the
 * moment it is gone, however it went.
 *
 * The holders that die are separate processes running the lease module as it
 * is (it imports only Node's built-ins), killed with SIGKILL.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { collectSharedStore } from '../src/index.js';
import { holdSharedStore, openCollection } from '../src/shared-store-lease.js';
import { LeaseReader } from '../src/store-lease-reader.js';
import { leaseDirectory, openLease } from '../src/store-lease.js';
import { cleanupWorlds, storeWithEntry } from './gc-race-fixture.js';
import { childEnv } from './ts-child.js';

const PACKAGE = fileURLToPath(new URL('..', import.meta.url));
const VITE_NODE = fileURLToPath(
  new URL('../../../node_modules/.bin/vite-node', import.meta.url),
);
const HOLDER = fileURLToPath(
  new URL('./fixtures/store-lease-holder.ts', import.meta.url),
);

const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  await cleanupWorlds();
});

/** Another process that holds a lease of `kind` with `line` in it. */
async function holder(
  store: string,
  kind: 'install' | 'gc',
  line: string,
): Promise<ChildProcess> {
  const child = spawn(VITE_NODE, [HOLDER, store, kind, line], {
    cwd: PACKAGE,
    stdio: ['ignore', 'pipe', 'inherit'],
    env: childEnv(),
  });
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('holder did not start within 30s')),
      30_000,
    );
    child.stdout!.on('data', (chunk: Buffer) => {
      if (!chunk.toString().includes('held')) return;
      clearTimeout(timeout);
      resolve();
    });
    child.on('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`holder exited ${code}`));
    });
  });
  return child;
}

async function kill(child: ChildProcess): Promise<void> {
  const exited = new Promise<void>((resolve) =>
    child.once('exit', () => resolve()),
  );
  child.kill('SIGKILL');
  await exited;
}

/** The parent sees a live cross-process lease holding `key` before GC runs. */
async function waitForLiveLease(
  store: string,
  kind: 'install' | 'gc',
  key: string,
  timeoutMs = 30_000,
): Promise<void> {
  const reader = new LeaseReader(leaseDirectory(store), kind, false);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await reader.holds(key)) return;
    await new Promise((wait) => setTimeout(wait, 20));
  }
  throw new Error(`${kind} lease never held ${key} live`);
}

describe('a lease', () => {
  it('is gone, files and directory, once its holder releases it', async () => {
    const { store } = await storeWithEntry();
    const lease = await openLease(leaseDirectory(store), 'install');
    await lease.write(`sha256-${'0'.repeat(64)}`);
    expect(await readdir(leaseDirectory(store))).toEqual(
      [`${lease.id}.keys`, `${lease.id}.lock`].sort(),
    );
    await lease.release();
    expect(await readdir(store)).not.toContain('.leases');
  });

  it("keeps another process's entry from a collection, and stops when that process is killed", async () => {
    const { env, store, key } = await storeWithEntry();
    const install = await holder(store, 'install', key);
    await waitForLiveLease(store, 'install', key);

    const dry = await collectSharedStore({
      env,
      minimumAgeMs: 0,
      dryRun: true,
    });
    expect(dry).toMatchObject({ removed: [], held: 1 });
    const held = await collectSharedStore({ env, minimumAgeMs: 0 });
    expect(held).toMatchObject({ removed: [], held: 1 });
    // The other process's claim does not stop this one from using the store.
    const mine = await holdSharedStore(store);
    await mine.claim(key);
    await mine.release();

    await kill(install);
    const freed = await collectSharedStore({ env, minimumAgeMs: 0 });
    expect(freed).toMatchObject({ removed: [join(store, key)], held: 0 });
    expect(await readdir(store)).not.toContain('.leases');
  }, 60_000);

  it('lets an install go on once a collection that was settling its entry is killed', async () => {
    const { store, key } = await storeWithEntry();
    const collection = await holder(store, 'gc', `+${key}`);
    await waitForLiveLease(store, 'gc', key);
    let pauses = 0;
    const hold = await holdSharedStore(store, {
      pause: async () => {
        pauses += 1;
        if (pauses === 1) await kill(collection);
      },
    });

    await hold.claim(key);
    await hold.release();

    expect(pauses).toBe(1);
  }, 60_000);

  it('makes an install wait while a collection settles its entry, and no longer', async () => {
    const { store, key } = await storeWithEntry();
    const collection = await openCollection(store, false);
    expect(await collection.claimed(key)).toBe(false);
    let pauses = 0;
    const hold = await holdSharedStore(store, {
      pause: async () => {
        pauses += 1;
        if (pauses === 2) await collection.settled(key);
      },
    });

    await hold.claim(key);
    expect(pauses).toBe(2);
    // The claim is there now, so the next collection leaves the entry.
    expect(await collection.claimed(key)).toBe(true);
    await collection.settled(key);
    await collection.release();
    await hold.release();
  });
});
