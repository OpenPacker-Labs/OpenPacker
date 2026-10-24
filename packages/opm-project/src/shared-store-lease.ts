/**
 * How an install and `opm gc --shared` agree on a shared store entry.
 *
 * An install decides an entry is present some time before it links it, and
 * until it links it nothing does: the window in which a collection used to
 * take the entry from under it. Now each side writes before it reads:
 *
 *   install, per entry                     collection, per entry
 *   1. claim: append the key to its lease  1. announce: append `+key`
 *   2. wait while a live collection has    2. leave the entry if a live install
 *      announced the key and not settled      has claimed it, or if something
 *      it                                     links it now
 *   3. look the entry up, publish it if    3. unpublish it (rename, records),
 *      need be, and link it                   then settle: append `-key`
 *
 * If the collection's step 2 does not see the claim, the claim was written
 * after step 2 began, so the install's step 2 began after the announcement and
 * waits until the entry is gone; it then publishes the entry again. If it does
 * see the claim it leaves the entry. Either way no install links an entry that
 * a collection removes. A claim lasts until the install releases its hold,
 * after its links are published; from then on the links keep the entry.
 *
 * Installs never wait for each other, a collection never waits for an install,
 * and an install waits for a collection only while it settles one entry, and
 * never longer than `ANNOUNCEMENT_WAIT_MS` on one announcement. A holder that
 * dies stops counting (`store-lease.ts`), except where it cannot be judged
 * from here, on another machine or in another pid namespace: an install then
 * goes on after that bound. Going on is safe: a collection unpublishes an
 * entry by one rename, `opm ci` looks at every entry it linked from once its
 * layout is written, and `opm install` publishes again an entry that vanished.
 */

import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  leaseDirectory,
  openLease,
  type Lease,
  type LeaseName,
  type LeaseOptions,
  type LeaseSteps,
} from './store-lease.js';
import { LeaseReader, sweepLeases } from './store-lease-reader.js';
import { OpmError } from './types.js';

// An archive's entry, or a patched copy of one (ADR 0057).
const STORE_KEY = /^sha256-[0-9a-f]{64}(?:-patch-[0-9a-f]{64})?$/u;

function assertKey(key: string): string {
  if (!STORE_KEY.test(key))
    throw new OpmError('INVALID_DIGEST', `Invalid store key ${key}`);
  return key;
}

export interface StoreHold {
  /**
   * Say that this install will use the entry `key`, before it looks the entry
   * up: a collection leaves it alone until the hold is released. Waits while a
   * collection is settling that entry.
   */
  claim(key: string): Promise<void>;
  /** End the hold. Every entry it claimed must be linked by now. */
  release(): Promise<void>;
}

export interface HoldOptions {
  /** How a claim waits between looks at a settling collection; a test seam. */
  pause?: (attempt: number, signal?: AbortSignal) => Promise<void>;
  /** The time, in milliseconds, on a clock that only goes forward; a test seam. */
  now?: () => number;
  /** Where a claim says it stopped waiting on a collection; stderr by default. */
  warn?: (message: string) => void;
  /** Ends a claim's wait, with the signal's reason. */
  signal?: AbortSignal;
  /** Where a test runs the other side of the protocol. */
  step?: LeaseSteps;
  /** How the install's lease files are opened; a test seam. */
  open?: LeaseOptions['open'];
}

/**
 * How long an install waits on one collection's announcement of one entry
 * before it goes on without it. A live collection settles an entry in
 * milliseconds; one that is still open after this has most likely died where
 * this process cannot tell (another machine, another pid namespace).
 */
export const ANNOUNCEMENT_WAIT_MS = 45_000;

interface Shared {
  refs: number;
  /** The collections' leases, read as they grow, by every claim of the hold. */
  collections: LeaseReader;
  /** When a claim first found each announcement (`<lease id> <key>`) open. */
  since: Map<string, number>;
  /** Announcements waited on for the whole bound: not waited on again. */
  passed: Set<string>;
  /**
   * The install's lease, opened by the first claim; `undefined` once that
   * found the store cannot be written here.
   */
  lease?: Promise<Lease | undefined>;
  claimed: Set<string>;
}

/** One install lease per store per process, held while anything uses it. */
const holds = new Map<string, Shared>();

/**
 * What opening a lease says of a store this process may read but not write:
 * a read-only mount, or a root whose mode or owner keeps it from writing.
 */
const UNWRITABLE = new Set(['EROFS', 'EACCES', 'EPERM']);

async function pauseBriefly(
  attempt: number,
  signal?: AbortSignal,
): Promise<void> {
  await sleep(Math.min(2 ** attempt, 50), undefined, { signal });
}

function warnOnStderr(message: string): void {
  process.stderr.write(`opm: ${message}\n`);
}

/**
 * The lease `shared` claims in, opened the first time it is needed. A store
 * this process cannot write gets none: such an install writes nothing there,
 * as before leases, and only adopts what the store holds; it still waits on
 * the collections it can see, and `opm ci` still checks after its layout
 * that every entry it linked from is there.
 */
function leaseOf(
  shared: Shared,
  directory: string,
  options: HoldOptions,
): Promise<Lease | undefined> {
  shared.lease ??= openLease(directory, 'install', {
    step: options.step,
    open: options.open,
  }).catch((error: unknown) => {
    // SAFETY: Node's file errors carry a string `code`.
    if (UNWRITABLE.has((error as NodeJS.ErrnoException).code ?? ''))
      return undefined;
    throw error;
  });
  return shared.lease;
}

/**
 * Wait while a live collection has announced `key` and not settled it, and
 * no longer than `ANNOUNCEMENT_WAIT_MS` on any one announcement.
 */
async function waitForCollections(
  shared: Shared,
  directory: string,
  key: string,
  options: HoldOptions,
): Promise<void> {
  const now = options.now ?? (() => performance.now());
  const pause = options.pause ?? pauseBriefly;
  for (let attempt = 0; ; attempt += 1) {
    options.signal?.throwIfAborted();
    const open = (await shared.collections.holders(key)).filter(
      (name) => !shared.passed.has(`${name.id} ${key}`),
    );
    if (open.length === 0) return;
    const time = now();
    for (const name of open) {
      const announcement = `${name.id} ${key}`;
      const since = shared.since.get(announcement) ?? time;
      shared.since.set(announcement, since);
      if (time - since < ANNOUNCEMENT_WAIT_MS) continue;
      shared.passed.add(announcement);
      (options.warn ?? warnOnStderr)(passedOver(directory, name, key));
    }
    if (open.every((name) => shared.passed.has(`${name.id} ${key}`))) return;
    await pause(attempt, options.signal);
  }
}

function passedOver(directory: string, name: LeaseName, key: string): string {
  return (
    `went on after waiting ${ANNOUNCEMENT_WAIT_MS / 1000} s for opm gc --shared to settle ${key}, ` +
    `announced in ${join(directory, `${name.id}.lock`)}, which this process cannot judge ` +
    `(another machine, another pid namespace, or a collection stopped there); ` +
    `an entry it removes is fetched again or named`
  );
}

/**
 * Hold the shared store at `storeRoot` for an install. Nothing is written to
 * the store until the first claim.
 */
export async function holdSharedStore(
  storeRoot: string,
  options: HoldOptions = {},
): Promise<StoreHold> {
  const directory = leaseDirectory(storeRoot);
  let shared = holds.get(directory);
  if (shared === undefined) {
    shared = {
      refs: 0,
      collections: new LeaseReader(directory, 'gc', true),
      since: new Map(),
      passed: new Set(),
      claimed: new Set(),
    };
    holds.set(directory, shared);
  }
  const mine = shared;
  mine.refs += 1;
  let released = false;
  return {
    async claim(key) {
      assertKey(key);
      const lease = await leaseOf(mine, directory, options);
      if (lease !== undefined && !mine.claimed.has(key)) {
        await lease.write(key);
        mine.claimed.add(key);
      }
      await options.step?.('install-claimed', key);
      await waitForCollections(mine, directory, key, options);
    },
    async release() {
      if (released) return;
      released = true;
      mine.refs -= 1;
      if (mine.refs > 0) return;
      if (holds.get(directory) === mine) holds.delete(directory);
      const lease = await mine.lease?.catch(() => undefined);
      await lease?.release();
    },
  };
}

export interface Collection {
  /**
   * Announce that the entry `key` is about to be collected, and say whether a
   * running install has claimed it (then it must stay). `settled` must follow.
   */
  claimed(key: string): Promise<boolean>;
  /** The collection has removed the entry, or left it. */
  settled(key: string): Promise<void>;
  release(): Promise<void>;
}

/**
 * Collect from the shared store at `storeRoot`. A dry run announces nothing,
 * removes nothing, and only reads the installs' claims.
 */
export async function openCollection(
  storeRoot: string,
  dryRun: boolean,
  step?: LeaseSteps,
): Promise<Collection> {
  const directory = leaseDirectory(storeRoot);
  const installs = new LeaseReader(directory, 'install', !dryRun);
  if (dryRun)
    return {
      claimed: (key) => installs.holds(assertKey(key)),
      settled: async () => undefined,
      release: async () => undefined,
    };
  await sweepLeases(directory, step);
  const lease = await openLease(directory, 'gc', { step });
  return {
    async claimed(key) {
      await lease.write(`+${assertKey(key)}`);
      await step?.('gc-announced', key);
      return installs.holds(key);
    },
    async settled(key) {
      await lease.write(`-${assertKey(key)}`);
      await step?.('gc-settled', key);
    },
    release: () => lease.release(),
  };
}
