/**
 * Who holds a lease, and whether that process may still be running.
 *
 * An owner is a pid and where it runs: the process's start time (a reused pid
 * starts later), its pid namespace, the machine's boot, and the machine (its
 * machine id and its host name). A lease's file names spell it in these
 * fields (`store-lease.ts`), `0` for one the process could not read.
 *
 * The machine id is spelled as a keyed digest (`leaseMachine`), never as the
 * id: machine-id(5) calls it confidential, and `.leases` sits in a store that
 * users, containers and machines may share. An opm before this one wrote the
 * id itself; a reader takes an owner whose machine digests to its own for one
 * of its machine (`asRead`), so such a lease is judged as it was. An opm that
 * writes the id reads this one's digest as another machine's, and so never
 * removes a lease of this one.
 *
 * It is judged by the one rule every holder opm records is judged by
 * (`process-owner.ts`), each side mapped onto that rule's record
 * (`asProcessOwner`). Where it runs (`ownerPlace`): an owner whose machine id
 * and host name are this machine's and whose boot is not this one ran in a
 * boot that has ended, and is dead. Any other owner in another pid namespace,
 * another boot or on another machine cannot be judged from here, and counts as
 * alive; so does one in this process's namespace when that cannot be read (on
 * Linux, where every process has one: `unreadableNamespaceIsForeign`, as a
 * holder that has a lock file of its own to be reclaimed by may ask). Whether
 * its pid here is still it (`isOwnerAlive`): see that function.
 */

import { createHash } from 'node:crypto';
import { readFile, readlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { placeHex } from './owner-digest.js';
import {
  isOwnerAlive as aliveBy,
  ownerPlace as placeOf,
  systemProbe,
  type OwnerPlace,
  type OwnerProbe,
  type PlaceOptions,
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
  /**
   * A keyed digest of `/etc/machine-id` (`leaseMachine`), or a digest of the
   * host name where there is none; 32 hex digits. An earlier opm wrote the id
   * itself, which a reader takes for its digest (`asRead`).
   */
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

/**
 * The machine a lease names for the machine id `id`: its keyed digest, the one
 * an owner record holds (`placeDigest` of `owner-digest.ts`) without its `d1-`,
 * so that it is 32 hex digits as the id was.
 */
export function leaseMachine(id: string): string {
  return placeHex('machine', id);
}

async function readMachine(): Promise<string> {
  for (const path of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
    const text = await readTrimmed(path);
    if (/^[0-9a-f]{32}$/u.test(text)) return leaseMachine(text);
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
    readMachine(),
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
 * `owner` as `reader` compares it: an owner whose machine is the id itself,
 * as an earlier opm wrote it, and digests to `reader`'s machine is of
 * `reader`'s machine. Any other owner is as it was written.
 */
export function asRead(owner: LeaseOwner, reader: LeaseOwner): LeaseOwner {
  return owner.machine !== reader.machine &&
    leaseMachine(owner.machine) === reader.machine
    ? { ...owner, machine: reader.machine }
    : owner;
}

/** The one owner rule, as a holder with a lock file of its own asks it. */
const RULE: PlaceOptions = { unreadableNamespaceIsForeign: true };

/**
 * Where `owner` runs, seen from `reader`, by the one owner rule: on this
 * machine in a boot that has ended (`ended`), where `reader` cannot judge it
 * (`elsewhere`: another machine, another boot it cannot place, another pid
 * namespace, or a namespace that could not be read), or `here`.
 */
export function ownerPlace(owner: LeaseOwner, reader: LeaseOwner): OwnerPlace {
  return placeOf(
    asProcessOwner(asRead(owner, reader)),
    asProcessOwner(reader),
    RULE,
  );
}

/**
 * Whether `owner` may still be running, by the one owner rule (`isOwnerAlive`
 * of `process-owner.ts`): false only when it ran in a boot of this machine
 * that has ended, or here when no process has its pid, the process that has it
 * is a zombie nobody reaped or dead (`X`), or that process started at another
 * time. Each of those has exited, and cannot release a lease.
 *
 * A reader that cannot read its own start time is perhaps looking at another
 * pid namespace's `/proc` (`unshare --pid` without `--mount-proc`), where a
 * pid's state and start time are another process's: it compares neither, and
 * takes every pid that answers signal 0 for alive. The signal is the kernel's
 * answer in the reader's own namespace, so a pid it does not find is gone.
 *
 * `reader` is the process judging, this one by default; `probe` is the
 * system, replaceable in a test.
 */
export async function isOwnerAlive(
  owner: LeaseOwner,
  reader?: LeaseOwner,
  probe: OwnerProbe = systemProbe,
): Promise<boolean> {
  const by = reader ?? (await currentOwner());
  return aliveBy(
    asProcessOwner(asRead(owner, by)),
    asProcessOwner(by),
    probe,
    RULE,
  );
}
