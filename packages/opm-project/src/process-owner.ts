import { createHash } from 'node:crypto';
import { asPlaceDigest } from './owner-digest.js';
import { currentOwner, systemProbe } from './owner-system.js';

export { placeDigest } from './owner-digest.js';
export {
  currentOwner,
  makeCurrentOwner,
  systemProbe,
  type OwnerReads,
} from './owner-system.js';

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
 * - `machineId`: a digest of `/etc/machine-id` (or
 *   `/var/lib/dbus/machine-id`), never the id: machine-id(5) calls it
 *   confidential, and a record sits in a project that is committed, cached and
 *   shared. A keyed hash (`placeDigest`, `d1-` and 32 hex digits) keeps all the
 *   rule needs, equality; a record an earlier opm wrote with the raw id is read
 *   back as its digest;
 * - `host`: the hostname (letters, digits, `.`, `_` and `-`; anything else is
 *   `_`, so that a host name cannot write to a terminal), which is all a
 *   system without a machine id offers;
 * - `bootId`: a digest of `/proc/sys/kernel/random/boot_id`, since pids start
 *   again at every boot;
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
 * pid as any other. So on a host with no machine id (most container images)
 * a holder left by a process that has ended is recovered within the boot it
 * was left in, and after a reboot it is `elsewhere`: that needs
 * `opm recover --abandon-step`, as does any holder opm cannot place.
 *
 * Where the place agrees, {@link isOwnerAlive} asks the pid:
 *
 * - signal 0 answers ESRCH: gone. EPERM (another user's process has the pid)
 *   and a pid that answers: look at the process;
 * - its `/proc/<pid>/stat` state is Z (a zombie that nobody reaped) or X
 *   (dead): gone, the process has ended. A Z that leads threads still running
 *   (its main thread exited, the others did not) is the process, and is
 *   alive: `/proc/<pid>/task` lists more than the leader;
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
 *
 * ## Other holders: what they map onto this
 *
 * The module is the one rule, so a holder with its own record maps its fields
 * onto {@link ProcessOwner} and calls it, whatever it is called there:
 *
 * - A holder that keeps its owner in a directory of its own (a run's scratch,
 *   a lease) writes it with `writeOwnerFile(dir)` right after making the
 *   directory and reads it with `readOwnerFile(dir)`: `.owner`, small,
 *   versioned JSON, replaced atomically, never read through a link
 *   (`owner-file.ts`). `ownerKey` is a name and cannot be turned back into an
 *   owner, so it is not a place to keep one. A directory with no file yet
 *   (`ownerFileProblem` says `missing`: its maker was killed between making it
 *   and writing the file) is judged by the age of the directory, as an empty
 *   step lock is; a file that is `unreadable` (cut short, a newer version, a
 *   link) is judged by nobody and is left alone.
 * - A holder whose own record has a host-name digest for the machine where the
 *   system has no machine id (a store lease) puts that digest in `machineId`,
 *   on both sides, and a field it writes as `'0'` for unreadable is
 *   `undefined` here. Any text of `[0-9A-Za-z-]{1,64}` is a field; a digest
 *   of the host name is as good as the machine's for the `ended` rule and no
 *   better: a clone of the machine with the same host name is the same machine.
 *   It judges with `ownerPlace(owner, reader, options)` first and
 *   `isOwnerAlive(owner, reader, probe, options)` for what is `here`; both
 *   take {@link PlaceOptions}.
 * - A start time or a pid read from the system is `systemProbe.stat(pid)`.
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
  /** How many threads `/proc/<pid>/task` lists; undefined where unreadable. */
  tasks?(pid: number): Promise<number | undefined>;
}

/** The fields compared before a pid is trusted to mean anything here. */
const PLACE = ['host', 'machineId', 'bootId', 'pidNamespace'] as const;

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
 * default; `probe` is the system, replaceable in a test; `options` are the
 * place rule's ({@link PlaceOptions}).
 */
export async function isOwnerAlive(
  owner: ProcessOwner,
  reader?: ProcessOwner,
  probe: OwnerProbe = systemProbe,
  options: PlaceOptions = {},
): Promise<boolean> {
  const here = reader ?? (await currentOwner());
  const place = ownerPlace(owner, here, options);
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
  if (now.state === 'X' || now.state === 'x') return false;
  // A zombie is gone, unless it is the leader of threads that still run.
  if (now.state === 'Z' && ((await probe.tasks?.(owner.pid)) ?? 0) <= 1)
    return false;
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
  if (typeof host !== 'string' || !/^[A-Za-z0-9._-]{1,255}$/u.test(host))
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
    owner[field] =
      field === 'machineId'
        ? asPlaceDigest('machine', text)
        : field === 'bootId'
          ? asPlaceDigest('boot', text)
          : text;
  }
  return owner;
}
