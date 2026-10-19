import { createHash } from 'node:crypto';
import { readFileSync, readlinkSync } from 'node:fs';
import { hostname } from 'node:os';

/**
 * The process that made a run's scratch, told apart well enough to say later,
 * from another process, whether it may still be running.
 *
 * A pid means something only on its machine, in its boot and in its PID
 * namespace: a run in a container that shares the cache, or on another machine
 * that shares it over NFS under the same host name, cannot see the owner's pid
 * and would take it for ended. So the owner is a pid with the time it started,
 * and short digests of its PID namespace, its boot, its machine id and its host
 * name ('' for what this host cannot read).
 */
export interface RunOwner {
  pid: number;
  /** When the pid started, in clock ticks since boot; '' where unknown. */
  start: string;
  /** The PID namespace the pid is numbered in. */
  pidNamespace: string;
  /** The boot the start time counts from. */
  boot: string;
  /** The machine id (/etc/machine-id). */
  machine: string;
  /** The host name. */
  host: string;
}

let current: RunOwner | undefined;

/** This process, as the owner of what it makes. */
export function currentOwner(): RunOwner {
  current ??= {
    pid: process.pid,
    start: startOf(process.pid) ?? '',
    pidNamespace: digest(read(() => readlinkSync('/proc/self/ns/pid'))),
    boot: digest(read(() => readFileSync('/proc/sys/kernel/random/boot_id'))),
    machine: digest(
      read(() => readFileSync('/etc/machine-id')) ??
        read(() => readFileSync('/var/lib/dbus/machine-id')),
    ),
    host: digest(hostname()),
  };
  return current;
}

/**
 * Whether the owner may still be running.
 *
 * - Of this machine (its machine id and host name) in an earlier boot: no.
 *   Nothing of that boot runs now, whatever its pids are.
 * - Of this machine, boot and PID namespace: not when its pid is unused, or
 *   used by a process that started at another time. A pid this process may
 *   not signal, or whose start it cannot read, is taken to be running, which
 *   only delays removing what it left.
 * - Anything else (another machine id or host name, another PID namespace, or
 *   a machine or boot this host cannot read) is another host or container
 *   sharing the store, and is taken to be running.
 *
 * Two machines with the same machine id and host name are one machine here,
 * as systemd's machine-id(5) requires the id to be unique.
 */
export function isOwnerAlive(owner: RunOwner): boolean {
  const here = currentOwner();
  const thisMachine =
    here.machine !== '' &&
    owner.machine === here.machine &&
    owner.host === here.host;
  if (
    thisMachine &&
    here.boot !== '' &&
    owner.boot !== '' &&
    owner.boot !== here.boot
  )
    return false;
  if (
    !thisMachine ||
    owner.boot !== here.boot ||
    owner.pidNamespace !== here.pidNamespace
  )
    return true;
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    // SAFETY: only the errno code of a failed signal is read.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
  const start = startOf(owner.pid);
  return owner.start === '' || start === undefined || start === owner.start;
}

/**
 * When `pid` started (field 22 of /proc/<pid>/stat), or undefined where that
 * cannot be read, including where /proc is another PID namespace's.
 */
export function startOf(pid: number): string | undefined {
  try {
    if (readlinkSync('/proc/self') !== String(process.pid)) return undefined;
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // The command name, in parentheses, may hold spaces; the fields after it
    // start at field 3.
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  } catch {
    return undefined;
  }
}

/** A short digest of `value`, or '' for a value this host cannot read. */
const digest = (value: string | undefined) =>
  value === undefined || value === ''
    ? ''
    : createHash('sha256').update(value).digest('hex').slice(0, 8);

function read(get: () => string | Buffer): string | undefined {
  try {
    return String(get()).trim();
  } catch {
    return undefined;
  }
}
