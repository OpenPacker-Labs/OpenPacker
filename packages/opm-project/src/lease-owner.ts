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
import {
  ownStartTime,
  parseMachineId,
  placeHex,
  type OwnerReads,
} from '@openpacker/project-io';
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
  /**
   * Clock ticks after boot when the process started (Linux), read only from a
   * `/proc` of its own pid namespace (`ownStartTime` of project-io's
   * `owner-system.ts`); `0` elsewhere.
   */
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

/**
 * The machine a lease names for the machine id `id`: its keyed digest, the one
 * an owner record holds (`placeDigest` of project-io's `owner-digest.ts`)
 * without its `d1-`, so that it is 32 hex digits as the id was.
 */
export function leaseMachine(id: string): string {
  return placeHex('machine', id);
}

/**
 * What this process reads to name itself, on every platform (where a file is
 * not there, its field is `0`): the reads of project-io's `owner-system.ts`,
 * whose files are read only on Linux, would change the machine of a lease made
 * on a BSD with a dbus machine id.
 */
const systemReads: OwnerReads = {
  pid: process.pid,
  hostname,
  stat: () => readFile('/proc/self/stat', 'utf8'),
  pidNamespace: async () =>
    /^pid:\[(\d+)\]$/u.exec(await readlink('/proc/self/ns/pid'))?.[1],
  bootId: () => readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
  machineId: async () => {
    for (const path of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
      const id = parseMachineId(await readFile(path, 'utf8').catch(() => ''));
      if (id !== undefined) return id;
    }
    return undefined;
  },
};

/** What `read` gives, or `undefined` where it fails. */
async function attempt(
  read: () => Promise<string | undefined>,
): Promise<string | undefined> {
  try {
    return await read();
  } catch {
    return undefined;
  }
}

/** This process as a lease names it, from `reads`. A test seam. */
export async function readLeaseOwner(reads: OwnerReads): Promise<LeaseOwner> {
  const [stat, namespace, boot, machineText] = await Promise.all([
    attempt(reads.stat),
    attempt(reads.pidNamespace),
    attempt(reads.bootId),
    attempt(reads.machineId),
  ]);
  // Only from a /proc of this process's own pid namespace, as an owner record.
  const start = ownStartTime(stat, reads.pid);
  const bootHex = boot?.trim().replaceAll('-', '').toLowerCase();
  const machineId =
    machineText === undefined ? undefined : parseMachineId(machineText);
  const host = createHash('sha256').update(reads.hostname()).digest('hex');
  return {
    pid: reads.pid,
    start: start ?? UNKNOWN,
    namespace:
      namespace !== undefined && /^\d+$/u.test(namespace) ? namespace : UNKNOWN,
    boot:
      bootHex !== undefined && /^[0-9a-f]{32}$/u.test(bootHex)
        ? bootHex
        : UNKNOWN,
    // A digest of the host name stands for the machine where there is no id.
    machine:
      machineId === undefined ? host.slice(0, 32) : leaseMachine(machineId),
    host: host.slice(0, 16),
  };
}

let current: Promise<LeaseOwner> | undefined;

/** This process, read once. */
export function currentOwner(): Promise<LeaseOwner> {
  current ??= readLeaseOwner(systemReads);
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
