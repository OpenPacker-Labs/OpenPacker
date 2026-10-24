/**
 * Who holds a lease, and whether that process may still be running.
 *
 * An owner is a pid and where it runs: the process's start time (a reused pid
 * starts later), its pid namespace, the machine's boot, and the machine (its
 * machine id and its host name). A lease's file names spell it in these
 * fields (`store-lease.ts`), `0` for one the process could not read.
 *
 * Where it runs is judged by the one rule every holder opm records is judged
 * by (`ownerPlace` of `process-owner.ts`), each side mapped onto that rule's
 * record (`asProcessOwner`): an owner whose machine id and host name are this
 * machine's and whose boot is not this one ran in a boot that has ended, and
 * is dead. Any other owner in another pid namespace, another boot or on
 * another machine cannot be judged from here, and counts as alive; so does one
 * in this process's namespace when that cannot be read (on Linux, where every
 * process has one: `unreadableNamespaceIsForeign`, as a holder that has a lock
 * file of its own to be reclaimed by may ask).
 */

import { createHash } from 'node:crypto';
import { readFile, readlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import {
  ownerPlace as placeOf,
  type OwnerPlace,
  type ProcessOwner,
} from './process-owner.js';

/** What a process could not read about itself. */
export const UNKNOWN = '0';

export interface LeaseOwner {
  pid: number;
  /** Clock ticks after boot when the process started (Linux); `0` elsewhere. */
  start: string;
  /** The pid namespace's inode (Linux); `0` elsewhere. */
  namespace: string;
  /** The kernel's boot id without dashes (Linux); `0` elsewhere. */
  boot: string;
  /** `/etc/machine-id`, or a digest of the host name where there is none. */
  machine: string;
  /** A digest of the host name: 16 hex digits. */
  host: string;
}

async function readTrimmed(path: string): Promise<string> {
  return readFile(path, 'utf8').then(
    (text) => text.trim(),
    () => '',
  );
}

async function machineId(): Promise<string> {
  for (const path of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
    const text = await readTrimmed(path);
    if (/^[0-9a-f]{32}$/u.test(text)) return text;
  }
  return createHash('sha256').update(hostname()).digest('hex').slice(0, 32);
}

function hostDigest(): string {
  return createHash('sha256').update(hostname()).digest('hex').slice(0, 16);
}

async function bootId(): Promise<string> {
  const text = (await readTrimmed('/proc/sys/kernel/random/boot_id'))
    .replaceAll('-', '')
    .toLowerCase();
  return /^[0-9a-f]{32}$/u.test(text) ? text : UNKNOWN;
}

async function pidNamespace(): Promise<string> {
  return readlink('/proc/self/ns/pid').then(
    (text) => /^pid:\[(\d+)\]$/u.exec(text)?.[1] ?? UNKNOWN,
    () => UNKNOWN,
  );
}

/** When process `pid` started, in clock ticks after boot (Linux). */
async function startTime(pid: number): Promise<string> {
  // `pid (comm) state ...`: comm may hold spaces and parentheses, so fields
  // are counted from the last `)`; starttime (field 22) is the 20th after it.
  const stat = await readTrimmed(`/proc/${pid}/stat`);
  const field = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  return field !== undefined && /^\d+$/u.test(field) ? field : UNKNOWN;
}

let current: Promise<LeaseOwner> | undefined;

/** This process, read once. */
export function currentOwner(): Promise<LeaseOwner> {
  current ??= Promise.all([
    startTime(process.pid),
    pidNamespace(),
    bootId(),
    machineId(),
  ]).then(([start, namespace, boot, machine]) => ({
    pid: process.pid,
    start,
    namespace,
    boot,
    machine,
    host: hostDigest(),
  }));
  return current;
}

/**
 * A lease's owner as the one owner rule's record: `0` is a field that was not
 * read, every other field is compared as the lease wrote it. The machine is
 * always read (a digest of the host name stands for it where there is no
 * machine id), so it is the record's machine on both sides, as
 * `process-owner.ts` asks of a holder that keeps its own codec.
 */
export function asProcessOwner(owner: LeaseOwner): ProcessOwner {
  const read = (value: string) => (value === UNKNOWN ? undefined : value);
  const [startTime, pidNamespace, bootId] = [
    read(owner.start),
    read(owner.namespace),
    read(owner.boot),
  ];
  return {
    pid: owner.pid,
    host: owner.host,
    machineId: owner.machine,
    ...(!(startTime === undefined) && { startTime }),
    ...(!(pidNamespace === undefined) && { pidNamespace }),
    ...(!(bootId === undefined) && { bootId }),
  };
}

/**
 * Where `owner` runs, seen from `reader`, by the one owner rule: on this
 * machine in a boot that has ended (`ended`), where `reader` cannot judge it
 * (`elsewhere`: another machine, another boot it cannot place, another pid
 * namespace, or a namespace that could not be read), or `here`.
 */
export function ownerPlace(owner: LeaseOwner, reader: LeaseOwner): OwnerPlace {
  return placeOf(asProcessOwner(owner), asProcessOwner(reader), {
    unreadableNamespaceIsForeign: true,
  });
}

/**
 * Whether `owner` may still be running: false only when it ran in a boot of
 * this machine that has ended, or when no process here has its pid, or the
 * one that has it started at another time.
 *
 * The pid is judged as the lease always judged it, not by `isOwnerAlive` of
 * `process-owner.ts`, which says more: a pid whose process is dead (`X`) or a
 * zombie whose threads it lists and finds none but the leader is gone there
 * and alive here, and a reader that cannot read its own start time takes
 * every pid here for alive there and compares the owner's here.
 */
export async function isOwnerAlive(
  owner: LeaseOwner,
  reader?: LeaseOwner,
): Promise<boolean> {
  const place = ownerPlace(owner, reader ?? (await currentOwner()));
  if (place !== 'here') return place === 'elsewhere';
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    // SAFETY: only the errno code of the failed signal is read.
    const code = (error as NodeJS.ErrnoException).code;
    // EPERM: another user's process has the pid, and it runs: whether it is
    // the owner still depends on when it started (below).
    if (code !== 'EPERM') return code !== 'ESRCH';
  }
  if (owner.start === UNKNOWN) return true;
  const now = await startTime(owner.pid);
  return now === UNKNOWN || now === owner.start;
}
