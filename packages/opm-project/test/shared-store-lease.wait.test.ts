/**
 * How long an install waits on a collection's announcement it cannot judge,
 * such as one left by a collection that died on another machine or in a
 * container: a bounded time, on a clock the test turns, then it warns naming
 * the lease and goes on. And it stops waiting when the install is cancelled.
 */

import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ANNOUNCEMENT_WAIT_MS,
  holdSharedStore,
} from '../src/shared-store-lease.js';
import { leaseDirectory } from '../src/store-lease.js';
import { cleanupWorlds, storeWithEntry, world } from './gc-race-fixture.js';

afterEach(cleanupWorlds);

/**
 * A collection lease left by a collection on another machine sharing the
 * store, which announced `keys` and settled none: always held from here.
 */
async function foreignCollection(
  store: string,
  keys: readonly string[],
): Promise<string> {
  const id = [
    'gc.proc.4242.1000.4026531836',
    'f'.repeat(32),
    'd'.repeat(16),
    'e'.repeat(32),
    randomUUID(),
  ].join('.');
  const directory = leaseDirectory(store);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${id}.lock`), '');
  await writeFile(
    join(directory, `${id}.keys`),
    keys.map((key) => `+${key}\n`).join(''),
  );
  return join(directory, `${id}.lock`);
}

/** A clock a claim's pauses move forward, and a bound on how many there are. */
function fakeTime(step: number) {
  let time = 1_000_000;
  let pauses = 0;
  return {
    now: () => time,
    pause: async () => {
      pauses += 1;
      if (pauses > 100) throw new Error('still waiting after 100 pauses');
      time += step;
    },
    get pauses() {
      return pauses;
    },
  };
}

describe('an install waiting on a collection it cannot judge', () => {
  it('goes on after the bound, warning once with the lease, and does not wait on that announcement again', async () => {
    const { store, key } = await storeWithEntry();
    const lock = await foreignCollection(store, [key]);
    const clock = fakeTime(10_000);
    const warnings: string[] = [];
    const hold = await holdSharedStore(store, {
      now: clock.now,
      pause: clock.pause,
      warn: (message) => warnings.push(message),
    });

    await hold.claim(key);
    const waited = clock.pauses;
    await hold.claim(key);

    expect(waited).toBe(Math.ceil(ANNOUNCEMENT_WAIT_MS / 10_000));
    expect(clock.pauses).toBe(waited);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(lock);
    expect(warnings[0]).toContain(key);
    await hold.release();
  });

  it('waits the whole bound for each entry such a collection announces, not once per collection', async () => {
    const { store, key } = await storeWithEntry();
    const other = `sha256-${'b'.repeat(64)}`;
    const lock = await foreignCollection(store, [key]);
    const clock = fakeTime(10_000);
    const warnings: string[] = [];
    const hold = await holdSharedStore(store, {
      now: clock.now,
      pause: clock.pause,
      warn: (message) => warnings.push(message),
    });

    await hold.claim(key);
    const first = clock.pauses;
    // The same collection settles that entry and announces another.
    await appendFile(lock.replace(/\.lock$/u, '.keys'), `-${key}\n+${other}\n`);
    await hold.claim(other);

    const bound = Math.ceil(ANNOUNCEMENT_WAIT_MS / 10_000);
    expect(first).toBe(bound);
    expect(clock.pauses - first).toBe(bound);
    expect(warnings).toHaveLength(2);
    expect(warnings[1]).toContain(other);
    await hold.release();
  });

  it('bounds the wait between 30 and 60 seconds', () => {
    expect(ANNOUNCEMENT_WAIT_MS).toBeGreaterThanOrEqual(30_000);
    expect(ANNOUNCEMENT_WAIT_MS).toBeLessThanOrEqual(60_000);
  });

  it('stops waiting when the install is cancelled', async () => {
    const { store, key } = await storeWithEntry();
    await foreignCollection(store, [key]);
    const cancel = new AbortController();
    const clock = fakeTime(1);
    const hold = await holdSharedStore(store, {
      now: clock.now,
      pause: async () => {
        await clock.pause();
        if (clock.pauses === 2) cancel.abort();
      },
      signal: cancel.signal,
      warn: () => undefined,
    });

    await expect(hold.claim(key)).rejects.toMatchObject({ name: 'AbortError' });
    expect(clock.pauses).toBe(2);
    await hold.release();
  });

  it("stops opm ci's wait when the install's signal aborts", async () => {
    const w = await world(1);
    await w.install(0);
    await w.unlink(0);
    const keys = (await readdir(w.store)).filter((name) =>
      name.startsWith('sha256-'),
    );
    await foreignCollection(w.store, keys);
    const cancel = new AbortController();

    await expect(
      w.install(
        0,
        { offline: true, signal: cancel.signal },
        {
          hold: {
            pause: async () => {
              cancel.abort();
            },
          },
        },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
