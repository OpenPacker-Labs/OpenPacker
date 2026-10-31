import { readFile, readdir, readlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { placeDigest } from './owner-digest.js';
import type { OwnerProbe, ProcessOwner } from './process-owner.js';

/**
 * What a process reads about itself to be named by a record
 * (`currentOwner`), and what it asks the system about another pid
 * (`systemProbe`). Both are replaceable in a test.
 */

/** The raw reads behind {@link currentOwner}; each may reject with the system's error. */
export interface OwnerReads {
  pid: number;
  hostname(): string;
  /** `/proc/self/stat`. */
  stat(): Promise<string | undefined>;
  /** The inode of `/proc/self/ns/pid`. */
  pidNamespace(): Promise<string | undefined>;
  /** `/proc/sys/kernel/random/boot_id`, as the system gives it. */
  bootId(): Promise<string | undefined>;
  /** `/etc/machine-id`, as the system gives it. */
  machineId(): Promise<string | undefined>;
}

/** A read that failed because the file is not there to read says that: it is the answer. */
const ABSENT = new Set([
  'ENOENT',
  'ENOTDIR',
  'EACCES',
  'EPERM',
  'EISDIR',
  'ELOOP',
  'ENOSYS',
]);

/** Text a terminal cannot misread and a record reads back: the rest is `_`. */
function safeHost(name: string): string {
  const host = name.replace(/[^A-Za-z0-9._-]/gu, '_').slice(0, 255);
  return host === '' ? 'unknown' : host;
}

/**
 * This process as a record would name it, from `reads`. Read once, and kept
 * once the read is whole: a read that failed for a reason that may pass (too
 * many open files, a busy `/proc`) leaves a record without its boot or
 * namespace, which every later reader would count as foreign, so it is read
 * again by the next caller. A file that is simply not there is an answer.
 */
export function makeCurrentOwner(
  reads: OwnerReads,
): () => Promise<ProcessOwner> {
  let cached: Promise<ProcessOwner> | undefined;
  return () => {
    cached ??= readOwner(reads).then(({ owner, whole }) => {
      if (!whole) cached = undefined;
      return owner;
    });
    return cached;
  };
}

async function readOwner(
  reads: OwnerReads,
): Promise<{ owner: ProcessOwner; whole: boolean }> {
  let whole = true;
  const attempt = async (
    read: () => Promise<string | undefined>,
  ): Promise<string | undefined> => {
    try {
      return await read();
    } catch (error) {
      // SAFETY: only the errno code of a failed read is looked at.
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === undefined || !ABSENT.has(code)) whole = false;
      return undefined;
    }
  };
  const [stat, pidNamespace, bootId, machineId] = await Promise.all([
    attempt(reads.stat),
    attempt(reads.pidNamespace),
    attempt(reads.bootId),
    attempt(reads.machineId),
  ]);
  const startTime = ownStartTime(stat, reads.pid);
  const owner: ProcessOwner = {
    pid: reads.pid,
    host: safeHost(reads.hostname()),
    ...(!(startTime === undefined) && { startTime }),
    ...(!(pidNamespace === undefined) && { pidNamespace }),
    ...(!(bootId === undefined || bootId === '') && {
      bootId: placeDigest('boot', bootId),
    }),
    ...(!(machineId === undefined) && {
      machineId: placeDigest('machine', machineId),
    }),
  };
  return { owner, whole };
}

/**
 * The start time of process `pid` from `stat`, the text of its
 * `/proc/self/stat`, only when that text names `pid`. The `/proc` this process
 * sees may be another PID namespace's (`unshare --pid` without
 * `--mount-proc`): its `self` then names this process by another pid, and its
 * `/proc/<pid>` are other processes, so no start time read there can be
 * compared. Undefined then, as where it cannot be read.
 */
export function ownStartTime(
  stat: string | undefined,
  pid: number,
): string | undefined {
  return stat !== undefined && Number(stat.split(' ', 1)[0]) === pid
    ? parseStat(stat)?.startTime
    : undefined;
}

const onLinux = <T>(read: () => Promise<T>): Promise<T | undefined> =>
  process.platform === 'linux' ? read() : Promise.resolve(undefined);

/** The machine id in the text of `/etc/machine-id`: 32 lower-case hex digits, or none. */
export function parseMachineId(text: string): string | undefined {
  const id = text.trim();
  return /^[0-9a-f]{32}$/u.test(id) ? id : undefined;
}

async function readMachineId(): Promise<string | undefined> {
  for (const path of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      // SAFETY: only the errno code of a failed read is looked at.
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== undefined && ABSENT.has(code)) continue;
      throw error;
    }
    const id = parseMachineId(text);
    if (id !== undefined) return id;
  }
  return undefined;
}

const systemReads: OwnerReads = {
  pid: process.pid,
  hostname,
  stat: () => onLinux(() => readFile('/proc/self/stat', 'utf8')),
  pidNamespace: () =>
    onLinux(
      async () =>
        /^pid:\[(\d+)\]$/u.exec(await readlink('/proc/self/ns/pid'))?.[1],
    ),
  bootId: () =>
    onLinux(async () =>
      (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(),
    ),
  machineId: () => onLinux(readMachineId),
};

/** This process, as a record would name it. Read once it is read whole. */
export const currentOwner = makeCurrentOwner(systemReads);

/** What the system says: `kill(pid, 0)`, `/proc/<pid>/stat` and `/proc/<pid>/task` (Linux). */
export const systemProbe: OwnerProbe = {
  signal: (pid) => {
    process.kill(pid, 0);
  },
  stat: async (pid) => {
    const text = await onLinux(() =>
      readFile(`/proc/${pid}/stat`, 'utf8'),
    ).catch(() => undefined);
    return text === undefined ? undefined : parseStat(text);
  },
  tasks: async (pid) =>
    (await onLinux(() => readdir(`/proc/${pid}/task`)).catch(() => undefined))
      ?.length,
};

/**
 * `pid (comm) state ppid …`: comm may hold spaces and parentheses, so the
 * fields are counted from the last `)`. The state is field 3, the start time
 * field 22, the 20th after it.
 */
export function parseStat(
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
