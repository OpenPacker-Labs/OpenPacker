/**
 * Whether the holder of a lease may still be running, judged from here.
 *
 * A lease's name says who made it and where (`lease-owner.ts`). An owner in a
 * boot of this machine that has ended is gone. One on another machine, in a
 * boot that cannot be placed or in another pid namespace counts as alive: an
 * install bounds how long it waits on one (`shared-store-lease.ts`), and a
 * collection leaves what it holds. Otherwise the lease is judged by its
 * mechanism, `how`: `proc` by whether the owner's pid has the lock file open
 * (and, when that cannot be looked at, as `pid` is), `pid` by the one owner
 * rule's pid check (`isOwnerAlive` of `lease-owner.ts`: the pid runs, is not a
 * zombie, and started when the owner did), `flock` and `share` by trying to
 * take the lock.
 *
 * Every verdict errs towards "held": a reader that cannot tell treats the
 * lease as live.
 */

import { constants, type Stats } from 'node:fs';
import { lstat, open, readdir, stat, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import {
  currentOwner,
  isOwnerAlive,
  ownerPlace,
  UNKNOWN,
  type LeaseOwner,
} from './lease-owner.js';
import type { OwnerProbe } from './process-owner.js';
import type { LeaseName, LeaseSteps } from './store-lease.js';

/** `O_EXLOCK` on macOS and the BSDs, which Node passes to `open(2)` as is. */
export const BSD_EXLOCK = 0x20;

function codeOf(error: unknown): string | undefined {
  // SAFETY: Node's file errors carry a string `code`; anything else has none.
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

export interface JudgeOptions {
  step?: LeaseSteps | undefined;
  /** Who reads; this process by default. A test seam. */
  reader?: LeaseOwner;
  /**
   * The names of the descriptors process `pid` has open; the listing of
   * `/proc/<pid>/fd` by default. A test seam.
   */
  descriptors?: (pid: number) => Promise<string[]>;
  /**
   * What the pid check asks of the system (signal 0, `/proc/<pid>/stat`,
   * `/proc/<pid>/task`); the system by default. A test seam.
   */
  probe?: OwnerProbe;
}

/**
 * Whether the holder of the lease named `name` may still be running: false
 * only when it certainly is not, or the lease has no lock at all.
 */
export async function leaseHeld(
  directory: string,
  name: LeaseName,
  options: JudgeOptions = {},
): Promise<boolean> {
  const reader = options.reader ?? (await currentOwner());
  const judge: Judge = {
    reader,
    descriptors: options.descriptors ?? listDescriptors,
    ...(options.probe !== undefined && { probe: options.probe }),
  };
  // A lock is `pending` until it is held and renamed to `lock`, so `pending`
  // is looked at first: one that is there is judged by its inode, which the
  // holder keeps open across the rename, and one that is gone has been
  // renamed, so `lock` is there when it is looked at next. The other order
  // misses a lock renamed between the two looks and calls it abandoned.
  for (const file of ['pending', 'lock'] as const) {
    const path = join(directory, `${name.id}.${file}`);
    const verdict = await heldAt(path, name, judge);
    await options.step?.('lease-judged', name.id);
    if (verdict !== 'gone') return verdict === 'held';
  }
  return false;
}

interface Judge {
  reader: LeaseOwner;
  descriptors: (pid: number) => Promise<string[]>;
  probe?: OwnerProbe;
}

async function heldAt(
  path: string,
  name: LeaseName,
  { reader, descriptors, probe }: Judge,
): Promise<'held' | 'free' | 'gone'> {
  const place = ownerPlace(name.owner, reader);
  if (place === 'here' && (name.how === 'flock' || name.how === 'share')) {
    const probe = await openProbe(path, name.how);
    if (probe === 'free') return 'free';
    return probe === 'ENOENT' ? 'gone' : 'held';
  }
  let target: Stats;
  try {
    target = await lstat(path);
  } catch (error) {
    return codeOf(error) === 'ENOENT' ? 'gone' : 'held';
  }
  if (place === 'ended') return 'free';
  if (place === 'elsewhere') return 'held';
  // A reader that cannot read its own start time may see another pid
  // namespace's /proc (`unshare --pid` without `--mount-proc`), where
  // /proc/<pid> is another process: its descriptors say nothing of the owner.
  const holds =
    name.how === 'proc' && reader.start !== UNKNOWN
      ? await procHolds(name.owner.pid, target, descriptors)
      : 'unknown';
  if (holds !== 'unknown') return holds ? 'held' : 'free';
  // Not told by an open file: the pid check of the one owner rule. For `proc`
  // that is all that tells a pid reused by a process whose descriptors this
  // reader may not look at; /proc/<pid>/stat is open to all.
  return (await isOwnerAlive(name.owner, reader, probe)) ? 'held' : 'free';
}

/**
 * Open `path` the way a reader probes a lock: the error code when it cannot
 * be opened (`EAGAIN` while another holds the `flock`, `EBUSY` while another
 * holds it unshared), `free` when it can.
 */
export async function openProbe(
  path: string,
  how: 'flock' | 'share',
): Promise<string> {
  const flags =
    how === 'flock'
      ? constants.O_RDONLY | constants.O_NONBLOCK | BSD_EXLOCK
      : constants.O_RDONLY;
  let handle: FileHandle;
  try {
    handle = await open(path, flags);
  } catch (error) {
    const code = codeOf(error) ?? 'UNKNOWN';
    return code === 'EWOULDBLOCK' ? 'EAGAIN' : code;
  }
  await handle.close();
  return 'free';
}

export function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function listDescriptors(pid: number): Promise<string[]> {
  return readdir(`/proc/${pid}/fd`);
}

/**
 * Whether process `pid` has `target` open: a descriptor on its inode.
 * `unknown` when some descriptors cannot be looked at, and none of the others
 * is it.
 */
async function procHolds(
  pid: number,
  target: Stats,
  descriptors: (pid: number) => Promise<string[]>,
): Promise<boolean | 'unknown'> {
  let names: string[];
  try {
    names = await descriptors(pid);
  } catch (error) {
    const code = codeOf(error);
    // Gone, or a zombie; anything else (another user's process, a hidden
    // /proc) cannot be looked at.
    return code === 'ENOENT' || code === 'ESRCH' ? false : 'unknown';
  }
  let hidden = false;
  for (const fd of names) {
    let seen: Stats;
    try {
      seen = await stat(`/proc/${pid}/fd/${fd}`);
    } catch (error) {
      // Closed since it was listed. Anything else cannot be told: a process
      // in another user namespace may list another's descriptors and not
      // follow them (EACCES).
      if (codeOf(error) !== 'ENOENT') hidden = true;
      continue;
    }
    if (sameFile(seen, target)) return true;
  }
  return hidden ? 'unknown' : false;
}
