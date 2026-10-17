import { readFile, readlink } from 'node:fs/promises';
import { hostname } from 'node:os';

/**
 * Which process holds something on disk (a step's lock, its rollback copy), and
 * whether that process may still be running.
 *
 * A pid names a process only inside one PID namespace, on one boot of one
 * machine. Two containers of a pod that share a volume, `docker --pid` or
 * `--uts=host`, a devcontainer and its host: each can see the same project with
 * the same hostname and count pids in a different table. So the record holds
 * where its pid is meaningful as well as the pid:
 *
 * - `machineId`: `/etc/machine-id` (or `/var/lib/dbus/machine-id`), and the
 *   hostname, which is all a system without one offers;
 * - `bootId`: `/proc/sys/kernel/random/boot_id`, since pids start again at
 *   every boot;
 * - `pidNamespace`: the inode of `/proc/self/ns/pid`;
 * - `startTime`: field 22 of `/proc/<pid>/stat`, since a pid is given to
 *   another process once its own ends.
 *
 * The rule ({@link processOwnerMayBeAlive}) never lets a live holder be judged
 * gone. Where any of the first three differs from this process's, or is known
 * on one side only, nothing here can judge the pid, and the holder counts as
 * alive. Where they agree, the pid must not answer signal 0 (ESRCH), or must
 * answer with another start time, for the holder to count as gone. A system
 * that says none of this (macOS, Windows) compares hostnames and pids alone:
 * a reused pid then keeps a stale holder waiting, never the reverse.
 */
export interface ProcessOwner {
  pid: number;
  /** For messages, and the machine where no machine id is available. */
  host: string;
  /** Clock ticks after boot when the process started (Linux). */
  startTime?: string;
  /** The inode of the PID namespace the pid belongs to (Linux). */
  pidNamespace?: string;
  /** This boot of the machine (Linux). */
  bootId?: string;
  /** The machine (Linux, from systemd or dbus). */
  machineId?: string;
}

/** The fields compared before a pid is trusted to mean anything here. */
const PLACE = ['host', 'machineId', 'bootId', 'pidNamespace'] as const;

let self: Promise<ProcessOwner> | undefined;

/** This process, as a record would name it. Read once per process. */
export function currentProcessOwner(): Promise<ProcessOwner> {
  self ??= readCurrentOwner();
  return self;
}

async function readCurrentOwner(): Promise<ProcessOwner> {
  const [startTime, pidNamespace, bootId, machineId] = await Promise.all([
    ownStartTime(),
    linuxOnly(async () => {
      const link = await readlink('/proc/self/ns/pid');
      return /^pid:\[(\d+)\]$/u.exec(link)?.[1];
    }),
    linuxOnly(async () =>
      (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(),
    ),
    linuxOnly(readMachineId),
  ]);
  return {
    pid: process.pid,
    host: hostname(),
    ...(!(startTime === undefined) && { startTime }),
    ...(!(pidNamespace === undefined) && { pidNamespace }),
    ...(!(bootId === undefined || bootId === '') && { bootId }),
    ...(!(machineId === undefined) && { machineId }),
  };
}

/**
 * Whether `owner` may still be running. False only when this process can tell
 * that it is not: same machine, boot and PID namespace, and the pid is free or
 * belongs to a process that started at another time.
 */
export async function processOwnerMayBeAlive(
  owner: ProcessOwner,
): Promise<boolean> {
  const here = await currentProcessOwner();
  for (const field of PLACE) if (owner[field] !== here[field]) return true;
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    // EPERM: a process of another user has the id, which is alive.
    // SAFETY: only the errno code of the failed signal is read.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
  if (owner.startTime === undefined) return true;
  // Only a /proc that belongs to this PID namespace says when a pid started
  // (`unshare --pid` without `--mount-proc` keeps the parent's).
  if (here.startTime === undefined) return true;
  const now = await startTimeOf(String(owner.pid));
  return now === undefined || now === owner.startTime;
}

/** `process 4242 on vm`, for messages. */
export function describeProcessOwner(owner: ProcessOwner): string {
  return `process ${owner.pid} on ${owner.host}`;
}

/**
 * A record read back from disk, checked field by field: anything else is
 * `undefined`, which a caller must treat as an owner it cannot judge.
 */
export function parseProcessOwner(value: unknown): ProcessOwner | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  // SAFETY: each field is checked below before it is used.
  const record = value as Record<string, unknown>;
  const { pid, host } = record;
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0)
    return undefined;
  if (typeof host !== 'string' || host === '' || host.length > 255)
    return undefined;
  const owner: ProcessOwner = { pid, host };
  for (const field of [
    'startTime',
    'pidNamespace',
    'bootId',
    'machineId',
  ] as const) {
    const text = record[field];
    if (text === undefined) continue;
    if (typeof text !== 'string' || !/^[0-9A-Za-z-]{1,64}$/u.test(text))
      return undefined;
    owner[field] = text;
  }
  return owner;
}

async function ownStartTime(): Promise<string | undefined> {
  const stat = await linuxOnly(() => readFile('/proc/self/stat', 'utf8'));
  // The /proc this process sees may be another PID namespace's: its `self`
  // then names another pid, and no start time it gives can be compared.
  if (stat === undefined || Number(stat.split(' ', 1)[0]) !== process.pid)
    return undefined;
  return startTimeField(stat);
}

async function startTimeOf(pid: string): Promise<string | undefined> {
  const stat = await linuxOnly(() => readFile(`/proc/${pid}/stat`, 'utf8'));
  return stat === undefined ? undefined : startTimeField(stat);
}

/**
 * `pid (comm) state ppid …`: comm may hold spaces and parentheses, so the
 * fields are counted from the last `)`. starttime is field 22, the 20th after
 * it.
 */
function startTimeField(stat: string): string | undefined {
  const field = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  return field !== undefined && /^\d+$/u.test(field) ? field : undefined;
}

async function readMachineId(): Promise<string | undefined> {
  for (const path of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
    const text = await readFile(path, 'utf8').catch(() => undefined);
    const id = text?.trim();
    if (id !== undefined && /^[0-9a-f]{32}$/u.test(id)) return id;
  }
  return undefined;
}

async function linuxOnly<T>(
  read: () => Promise<T | undefined>,
): Promise<T | undefined> {
  if (process.platform !== 'linux') return undefined;
  try {
    return await read();
  } catch {
    return undefined;
  }
}
