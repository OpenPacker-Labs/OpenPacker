import { createHash } from 'node:crypto';
import { readFile, readlink } from 'node:fs/promises';
import { hostname } from 'node:os';

/**
 * Which process holds something on disk (a step's lock, its rollback copy), and
 * whether that process may still be running. The one rule for every holder opm
 * records; other owners (a run's scratch, a store lease) judge by it too.
 *
 * A pid names a process only inside one PID namespace, on one boot of one
 * machine. Two containers of a pod that share a volume, `docker --pid` or
 * `--uts=host`, a devcontainer and its host: each can see the same project with
 * the same hostname and count pids in a different table. So the record holds
 * where its pid is meaningful as well as the pid:
 *
 * - `machineId`: `/etc/machine-id` (or `/var/lib/dbus/machine-id`);
 * - `host`: the hostname, which is all a system without a machine id offers;
 * - `bootId`: `/proc/sys/kernel/random/boot_id`, since pids start again at
 *   every boot;
 * - `pidNamespace`: the inode of `/proc/self/ns/pid`;
 * - `startTime`: field 22 of `/proc/<pid>/stat`, since a pid is given to
 *   another process once its own ends.
 *
 * ## The rule
 *
 * {@link ownerPlace} says where an owner runs, seen from a reader:
 *
 * - `ended`: the owner is of this machine (the machine id is known and equal
 *   on both sides, and the hostname equal) and of another boot that both sides
 *   know. Every process of that boot ended with it. The only judgement made
 *   without looking at a pid.
 * - `elsewhere`: any other difference in host, machine id, boot id or PID
 *   namespace. Nothing here can judge the pid.
 * - `here`: the place agrees. The pid decides ({@link isOwnerAlive}).
 *
 * A field is compared as a value, and unreadable is a value (`undefined`):
 *
 * | owner's field | reader's field | meaning                                     |
 * |---------------|----------------|---------------------------------------------|
 * | a value       | the same       | agrees                                      |
 * | a value       | another        | `elsewhere` (`ended` for the boot, above)   |
 * | a value       | unreadable     | `elsewhere`: the reader cannot place it     |
 * | unreadable    | a value        | `elsewhere`: the owner could not be placed  |
 * | unreadable    | unreadable     | agrees: the same kind of process on a host  |
 * |               |                | that hides it; nothing says they differ     |
 *
 * Unreadable on both sides is "agrees" so that a holder left by a process that
 * could not read the field is not immortal: the rule never needs a field that
 * neither side has. The cost is that two such processes on one host name,
 * sharing a volume in different PID namespaces, would count each other's pid
 * in the wrong table. That is rare (on Linux every process can read its own
 * namespace and boot), and a caller that cannot accept it passes
 * `unreadableNamespaceIsForeign`: a reader with no PID namespace on Linux then
 * sees every owner as `elsewhere`. That makes a dead owner of such a host
 * immortal, so it suits a holder that has another way to be reclaimed (a lease
 * with its own lock file), not a step lock, whose way out is
 * `opm recover --abandon-step`.
 *
 * The machine id matters in one place only: the `ended` rule. Unreadable on
 * both sides it makes no claim about boots; the owner is then judged by its
 * pid as any other, so a step killed on a host with no machine id is still
 * recovered.
 *
 * Where the place agrees, {@link isOwnerAlive} asks the pid:
 *
 * - signal 0 answers ESRCH: gone. EPERM (another user's process has the pid)
 *   and a pid that answers: look at the process;
 * - its `/proc/<pid>/stat` state is Z (a zombie that nobody reaped) or X
 *   (dead): gone, the process has ended;
 * - its start time differs from the recorded one: gone, the pid was reused.
 *   Not compared when this process cannot read its own start time (a `/proc`
 *   of another PID namespace) or the record has none; then it is alive;
 * - anything unreadable (the stat, a `hidepid` mount): alive.
 *
 * So `isOwnerAlive` is false only when it is certain. A system that says none
 * of this (macOS, Windows) compares hostnames and pids alone: a reused pid
 * keeps a stale holder waiting, never the reverse; run there, it is not
 * tested.
 *
 * The `ended` rule trusts the machine id: two machines cloned from one image
 * that kept its `/etc/machine-id`, with one hostname, sharing a project, would
 * each take the other's live holder for one of an earlier boot.
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

/** Where an owner runs, seen from a reader. */
export type OwnerPlace = 'ended' | 'elsewhere' | 'here';

export interface PlaceOptions {
  /** See the header: on Linux, a reader with no PID namespace sees no owner `here`. */
  unreadableNamespaceIsForeign?: boolean;
}

/** What `isOwnerAlive` asks of the system; replaceable in a test. */
export interface OwnerProbe {
  /** Signal 0 to `pid`. Throws the error the system gave. */
  signal(pid: number): void;
  /** State letter and start time from `/proc/<pid>/stat`; undefined where unreadable. */
  stat(pid: number): Promise<{ state: string; startTime: string } | undefined>;
}

/** The fields compared before a pid is trusted to mean anything here. */
const PLACE = ['host', 'machineId', 'bootId', 'pidNamespace'] as const;

let self: Promise<ProcessOwner> | undefined;

/** This process, as a record would name it. Read once per process. */
export function currentOwner(): Promise<ProcessOwner> {
  self ??= readCurrentOwner();
  return self;
}

async function readCurrentOwner(): Promise<ProcessOwner> {
  const [stat, pidNamespace, bootId, machineId] = await Promise.all([
    linuxOnly(() => readFile('/proc/self/stat', 'utf8')),
    linuxOnly(async () => {
      const link = await readlink('/proc/self/ns/pid');
      return /^pid:\[(\d+)\]$/u.exec(link)?.[1];
    }),
    linuxOnly(async () =>
      (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(),
    ),
    linuxOnly(readMachineId),
  ]);
  // The /proc this process sees may be another PID namespace's: its `self`
  // then names another pid, and no start time it gives can be compared.
  const own =
    stat !== undefined && Number(stat.split(' ', 1)[0]) === process.pid
      ? parseStat(stat)
      : undefined;
  return {
    pid: process.pid,
    host: hostname(),
    ...(!(own === undefined) && { startTime: own.startTime }),
    ...(!(pidNamespace === undefined) && { pidNamespace }),
    ...(!(bootId === undefined || bootId === '') && { bootId }),
    ...(!(machineId === undefined) && { machineId }),
  };
}

/** Where `owner` runs, seen from `reader`. See the header for each case. */
export function ownerPlace(
  owner: ProcessOwner,
  reader: ProcessOwner,
  options: PlaceOptions = {},
): OwnerPlace {
  if (
    reader.machineId !== undefined &&
    owner.machineId === reader.machineId &&
    owner.host === reader.host &&
    reader.bootId !== undefined &&
    owner.bootId !== undefined &&
    owner.bootId !== reader.bootId
  )
    return 'ended';
  for (const field of PLACE)
    if (owner[field] !== reader[field]) return 'elsewhere';
  if (
    options.unreadableNamespaceIsForeign === true &&
    process.platform === 'linux' &&
    reader.pidNamespace === undefined
  )
    return 'elsewhere';
  return 'here';
}

/**
 * Whether `owner` may still be running. False only when this process can tell
 * that it is not: see the header. `reader` is the process judging, this one by
 * default; `probe` is the system, replaceable in a test.
 */
export async function isOwnerAlive(
  owner: ProcessOwner,
  reader?: ProcessOwner,
  probe: OwnerProbe = systemProbe,
): Promise<boolean> {
  const here = reader ?? (await currentOwner());
  const place = ownerPlace(owner, here);
  if (place !== 'here') return place === 'elsewhere';
  try {
    probe.signal(owner.pid);
  } catch (error) {
    // SAFETY: only the errno code of the failed signal is read.
    const code = (error as NodeJS.ErrnoException).code;
    // EPERM: another user's process has the pid; it still has to be this one.
    if (code === 'ESRCH') return false;
    if (code !== 'EPERM') return true;
  }
  // Only a /proc that belongs to this PID namespace says anything about a pid
  // (`unshare --pid` without `--mount-proc` keeps the parent's).
  if (here.startTime === undefined) return true;
  const now = await probe.stat(owner.pid);
  if (now === undefined) return true;
  if (now.state === 'Z' || now.state === 'X' || now.state === 'x') return false;
  return owner.startTime === undefined || now.startTime === owner.startTime;
}

/**
 * A name for an owner: 32 hex digits of a digest of every field, the same in
 * every process and safe in a file name. Equal owners have equal keys; the
 * owner cannot be read back from it, so a record keeps the owner itself.
 */
export function ownerKey(owner: ProcessOwner): string {
  const fields = [
    owner.pid,
    owner.host,
    owner.startTime ?? null,
    owner.pidNamespace ?? null,
    owner.bootId ?? null,
    owner.machineId ?? null,
  ];
  return createHash('sha256')
    .update(JSON.stringify(fields))
    .digest('hex')
    .slice(0, 32);
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

/** What the system says: `kill(pid, 0)` and `/proc/<pid>/stat` (Linux). */
export const systemProbe: OwnerProbe = {
  signal: (pid) => {
    process.kill(pid, 0);
  },
  stat: async (pid) => {
    const text = await linuxOnly(() => readFile(`/proc/${pid}/stat`, 'utf8'));
    return text === undefined ? undefined : parseStat(text);
  },
};

/**
 * `pid (comm) state ppid …`: comm may hold spaces and parentheses, so the
 * fields are counted from the last `)`. The state is field 3, the start time
 * field 22, the 20th after it.
 */
function parseStat(
  stat: string,
): { state: string; startTime: string } | undefined {
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const [state] = fields;
  const startTime = fields[19];
  return state !== undefined &&
    /^[A-Za-z]$/u.test(state) &&
    startTime !== undefined &&
    /^\d+$/u.test(startTime)
    ? { state, startTime }
    : undefined;
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
