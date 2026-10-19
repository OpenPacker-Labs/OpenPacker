/**
 * Reading the leases in a store (`store-lease.ts`): the lines their holders
 * append, as they grow, and whether each holder may still be running.
 */

import { open, readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
  isRetiredLeaseName,
  leaseHeld,
  parseLeaseName,
  removeLease,
  RETIRED_LEASE_AGE_MS,
  type LeaseKind,
  type LeaseName,
  type LeaseSteps,
} from './store-lease.js';

function isMissing(error: unknown): boolean {
  // SAFETY: Node's file errors carry a string `code`.
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

interface Seen {
  name: LeaseName;
  /** Bytes of the keys file read so far, up to its last whole line. */
  offset: number;
  /** Keys the holder holds: claimed, or announced and not yet settled. */
  open: Set<string>;
  abandoned: boolean;
}

/** The leases of one kind in a store, read as they grow. */
export class LeaseReader {
  readonly #directory: string;
  readonly #kind: LeaseKind;
  /** Whether to remove the abandoned leases it finds (not on a dry run). */
  readonly #tidy: boolean;
  readonly #seen = new Map<string, Seen>();
  /** A read that has not started yet. */
  #queued: Promise<void> | undefined;
  /** The last read, settled either way. */
  #last: Promise<void> = Promise.resolve();

  constructor(directory: string, kind: LeaseKind, tidy: boolean) {
    this.#directory = directory;
    this.#kind = kind;
    this.#tidy = tidy;
  }

  /** Whether a live holder has `key` open. */
  async holds(key: string): Promise<boolean> {
    return (await this.holders(key)).length > 0;
  }

  /** The leases whose holders may be live and have `key` open. */
  async holders(key: string): Promise<LeaseName[]> {
    await this.#refresh();
    const live: LeaseName[] = [];
    for (const lease of this.#seen.values()) {
      if (lease.abandoned || !lease.open.has(key)) continue;
      if (await leaseHeld(this.#directory, lease.name)) {
        live.push(lease.name);
        continue;
      }
      lease.abandoned = true;
      if (this.#tidy) await removeLease(this.#directory, lease.name.id);
    }
    return live;
  }

  /**
   * Read what the leases have gained since. Reads run one at a time, each
   * from where the last stopped; a caller gets a read that starts after it
   * called, so it sees whatever was written before, and callers that arrive
   * while one read is queued share it.
   */
  #refresh(): Promise<void> {
    if (this.#queued !== undefined) return this.#queued;
    const queued = this.#last.then(() => {
      if (this.#queued === queued) this.#queued = undefined;
      return this.#read();
    });
    this.#queued = queued;
    this.#last = queued.catch(() => undefined);
    return queued;
  }

  async #read(): Promise<void> {
    const present = new Set<string>();
    for (const file of await listLeases(this.#directory)) {
      const name = parseLeaseName(file);
      if (name?.kind !== this.#kind || name.file !== 'keys') continue;
      present.add(name.id);
      let lease = this.#seen.get(name.id);
      if (lease === undefined) {
        lease = { name, offset: 0, open: new Set(), abandoned: false };
        this.#seen.set(name.id, lease);
      }
      if (!lease.abandoned) await this.#readMore(lease);
    }
    for (const id of this.#seen.keys())
      if (!present.has(id)) this.#seen.delete(id);
  }

  async #readMore(lease: Seen): Promise<void> {
    const path = join(this.#directory, `${lease.name.id}.keys`);
    const handle = await open(path, 'r').catch((error: unknown) => {
      if (isMissing(error)) return undefined;
      throw error;
    });
    if (handle === undefined) return;
    try {
      const { size } = await handle.stat();
      if (size <= lease.offset) return;
      const buffer = Buffer.alloc(size - lease.offset);
      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.length,
        lease.offset,
      );
      // A line still being appended is read next time, whole.
      const whole = buffer.subarray(0, bytesRead).lastIndexOf(0x0a) + 1;
      lease.offset += whole;
      for (const line of buffer.subarray(0, whole).toString('utf8').split('\n'))
        if (line.startsWith('-')) lease.open.delete(line.slice(1));
        else if (line !== '') lease.open.add(line.replace(/^\+/u, ''));
    } finally {
      await handle.close();
    }
  }
}

async function listLeases(directory: string): Promise<string[]> {
  try {
    return await readdir(directory);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

/**
 * Remove every lease in the store whose holder is gone, and the files of
 * leases in names no build reads any more once they are a day old.
 */
export async function sweepLeases(
  directory: string,
  step: LeaseSteps | undefined,
): Promise<void> {
  const ids = new Map<string, LeaseName>();
  for (const file of await listLeases(directory)) {
    const name = parseLeaseName(file);
    if (name !== undefined) ids.set(name.id, name);
    else if (isRetiredLeaseName(file)) await removeIfOld(join(directory, file));
  }
  for (const name of ids.values())
    if (!(await leaseHeld(directory, name, { step })))
      await removeLease(directory, name.id);
}

async function removeIfOld(path: string): Promise<void> {
  const info = await stat(path).catch(() => undefined);
  if (info !== undefined && Date.now() - info.mtimeMs >= RETIRED_LEASE_AGE_MS)
    await unlink(path).catch(() => undefined);
}
