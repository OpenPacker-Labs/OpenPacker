/**
 * A lease on the shared package store: files that say what a running process
 * is using, and that stop counting the moment that process is gone.
 *
 * A lease is two files in `<store>/.leases/`, both named for its holder:
 *
 * - `<id>.lock`, which the holder keeps open (and, where the platform can,
 *   locked) for as long as it lives;
 * - `<id>.keys`, the lines the holder appends: the entries an install uses, or
 *   the entries a collection is deciding on.
 *
 * `<id>` is `<kind>.<how>.<pid>.<start>.<pid namespace>.<machine>.<host>.<boot>.<uuid>`:
 * the holder (`lease-owner.ts`) and the mechanism, `how`, by which a reader on
 * the same machine, boot and pid namespace tells a held lock from an abandoned
 * one (`store-lease-liveness.ts`):
 *
 * - `proc` (Linux): the holder's `/proc/<pid>/fd` has a descriptor on the lock
 *   file's inode. A dead process has none, and a process that reused the pid
 *   does not have this file open. Where the descriptors cannot be looked at
 *   (the pid is now another user's process), or this reader's `/proc` may not
 *   be its own pid namespace's (it cannot read its own start time), the lease
 *   is judged as `pid`.
 * - `flock` (macOS and the BSDs): the lock is opened with `O_EXLOCK`; a reader
 *   that can take the same lock without waiting knows nobody holds it.
 * - `share` (Windows): the lock is opened with no sharing allowed; a reader
 *   that can open it knows nobody holds it.
 * - `pid`, where none of those held when the lease was made: the holder's pid
 *   is running, is not a zombie nobody reaped or dead, and (where the system
 *   says) started when the holder did: the pid check every holder opm records
 *   is judged by (`isOwnerAlive` of `process-owner.ts`). A reused pid that
 *   cannot be told apart keeps an abandoned lease alive until that process
 *   ends: a delay for a collection, never a wrong removal.
 *
 * The first three are tied to an open file, which the operating system closes
 * when a process dies however it dies, so no lease outlives its holder. Each is
 * checked when the lease is made, and a platform or filesystem where it does
 * not hold gets `pid` instead.
 *
 * The lock is held before it is published: it is made as `<id>.pending` and
 * renamed to `<id>.lock` (Windows creates it held, in one call). The keys file
 * is created after the lock and removed before it, so keys without a lock are
 * always abandoned.
 */

import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  mkdir,
  open,
  rename,
  rmdir,
  stat,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { join } from 'node:path';
import { currentOwner, type LeaseOwner } from './lease-owner.js';
import { BSD_EXLOCK, openProbe, sameFile } from './store-lease-liveness.js';

export { leaseHeld } from './store-lease-liveness.js';

export const LEASE_DIRECTORY = '.leases';

export type LeaseKind = 'install' | 'gc';
export type Mechanism = 'proc' | 'flock' | 'share' | 'pid';
type LeaseFile = 'lock' | 'keys' | 'pending';

/** libuv's `UV_FS_O_EXLOCK` on Windows: open with a sharing mode of 0. */
const WINDOWS_EXLOCK = 0x10000000;

const NAME = new RegExp(
  [
    '^(install|gc)',
    '(proc|flock|share|pid)',
    '(\\d+)',
    '(\\d+)',
    '(\\d+)',
    '([0-9a-f]{32})',
    '([0-9a-f]{16})',
    '([0-9a-f]{32}|0)',
    '([0-9a-f-]{36})',
    '(lock|keys|pending)$',
  ].join('\\.'),
  'u',
);

/**
 * The names earlier builds of this change gave a lease: `<kind>.<how>.<pid>.
 * <pid namespace>.<uuid>`, then with the start time, machine and boot too.
 * Nothing reads such a lease, so it neither protects an entry nor exposes
 * one; a collection removes its files once they are `RETIRED_LEASE_AGE_MS` old
 * (`store-lease-reader.ts`), so that they do not keep `.leases` from being
 * removed. Names of no known format are not swept.
 */
const RETIRED_NAMES = [
  /^(install|gc)\.(proc|flock|share|pid)\.\d+\.\d+\.[0-9a-f-]{36}\.(lock|keys|pending)$/u,
  /^(install|gc)\.(proc|flock|share|pid)(\.\d+){3}\.[0-9a-f]{32}\.([0-9a-f]{32}|0)\.[0-9a-f-]{36}\.(lock|keys|pending)$/u,
];

/** How old a retired lease's file must be before a collection removes it. */
export const RETIRED_LEASE_AGE_MS = 24 * 60 * 60 * 1000;

export function isRetiredLeaseName(name: string): boolean {
  return RETIRED_NAMES.some((pattern) => pattern.test(name));
}

export interface LeaseName {
  id: string;
  kind: LeaseKind;
  how: Mechanism;
  owner: LeaseOwner;
  file: LeaseFile;
}

/**
 * A point in the protocol, between a write to `.leases` and a read of it that
 * must come after, where a test runs another process's side. Internal: no
 * module the package exports takes one.
 */
export type LeaseStep =
  /** A lock is open and held, and not yet published as `.lock`. */
  | 'lease-opened'
  /** A reader has judged one file of a lease, and not yet the other. */
  | 'lease-judged'
  /** An install has claimed an entry and not yet looked for announcements. */
  | 'install-claimed'
  /** A collection has announced an entry and not yet looked for claims. */
  | 'gc-announced'
  /** A collection has settled an entry: unpublished it, or left it. */
  | 'gc-settled';

/** Called at each step with the lease's id, or the entry's key for the last three. */
export type LeaseSteps = (step: LeaseStep, id: string) => Promise<void>;

export interface LeaseOptions {
  step?: LeaseSteps | undefined;
  /** The mechanism to try first; this platform's by default. A test seam. */
  how?: Mechanism;
  /** How the lease's files are opened; `fs.promises.open` by default. A test seam. */
  open?: typeof open | undefined;
}

export interface Lease {
  readonly id: string;
  /** Append one line every reader of the lease will see. */
  write(line: string): Promise<void>;
  /** Stop holding the lease and remove its files. */
  release(): Promise<void>;
}

export function leaseDirectory(storeRoot: string): string {
  return join(storeRoot, LEASE_DIRECTORY);
}

export function parseLeaseName(name: string): LeaseName | undefined {
  const match = NAME.exec(name);
  if (match === null) return undefined;
  const [, kind, how, pid, start, namespace, machine, host, boot, uuid, file] =
    match;
  return {
    // SAFETY: the pattern admits exactly these alternatives.
    kind: kind as LeaseKind,
    // SAFETY: the pattern admits exactly these alternatives.
    how: how as Mechanism,
    owner: {
      pid: Number(pid),
      start: start!,
      namespace: namespace!,
      machine: machine!,
      host: host!,
      boot: boot!,
    },
    // SAFETY: the pattern admits exactly these alternatives.
    file: file as LeaseFile,
    id: [kind, how, pid, start, namespace, machine, host, boot, uuid].join('.'),
  };
}

function codeOf(error: unknown): string | undefined {
  // SAFETY: Node's file errors carry a string `code`; anything else has none.
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function preferredMechanism(): Mechanism {
  switch (process.platform) {
    case 'linux':
      return 'proc';
    case 'win32':
      return 'share';
    case 'darwin':
    case 'freebsd':
    case 'openbsd':
    case 'netbsd':
      return 'flock';
    default:
      return 'pid';
  }
}

function lockFlags(how: Mechanism): number {
  const flags = constants.O_CREAT | constants.O_EXCL | constants.O_RDWR;
  if (how === 'flock') return flags | BSD_EXLOCK;
  if (how === 'share') return flags | WINDOWS_EXLOCK;
  return flags;
}

/**
 * Hold a new lease of `kind` in `directory`, creating the directory (its
 * parent, the store, must be there).
 */
export async function openLease(
  directory: string,
  kind: LeaseKind,
  options: LeaseOptions = {},
): Promise<Lease> {
  const owner = await currentOwner();
  for (let attempt = 0; ; attempt += 1) {
    // Not recursive: the store is there, and a recursive mkdir reports a
    // read-only filesystem as ENOENT, which reads as a directory removed
    // meanwhile.
    await mkdir(directory, { mode: 0o700 }).catch((error: unknown) => {
      if (codeOf(error) !== 'EEXIST') throw error;
    });
    try {
      return await createLease(
        directory,
        kind,
        owner,
        options.how ?? preferredMechanism(),
        options,
      );
    } catch (error) {
      // A holder releasing the last lease removes the directory; make it again.
      if (attempt < 4 && codeOf(error) === 'ENOENT') continue;
      throw error;
    }
  }
}

async function createLease(
  directory: string,
  kind: LeaseKind,
  owner: LeaseOwner,
  how: Mechanism,
  options: LeaseOptions,
): Promise<Lease> {
  const openFile = options.open ?? open;
  const id = [
    kind,
    how,
    owner.pid,
    owner.start,
    owner.namespace,
    owner.machine,
    owner.host,
    owner.boot,
    randomUUID(),
  ].join('.');
  const lockPath = join(directory, `${id}.lock`);
  const first = how === 'share' ? lockPath : join(directory, `${id}.pending`);
  let lock: FileHandle;
  try {
    lock = await openFile(first, lockFlags(how), 0o600);
  } catch (error) {
    // A filesystem that cannot `flock` (some network ones) refuses O_EXLOCK.
    const code = codeOf(error);
    if (how === 'flock' && (code === 'ENOTSUP' || code === 'EOPNOTSUPP'))
      return createLease(directory, kind, owner, 'pid', options);
    throw error;
  }
  let keys: FileHandle | undefined;
  try {
    if (!(await holdsItself(lock, first, how))) {
      await lock.close();
      await unlink(first);
      return await createLease(directory, kind, owner, 'pid', options);
    }
    await options.step?.('lease-opened', id);
    if (first !== lockPath) await rename(first, lockPath);
    const keysPath = join(directory, `${id}.keys`);
    keys = await openFile(
      keysPath,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_APPEND,
      0o600,
    );
    return heldLease(directory, id, lock, keys);
  } catch (error) {
    await keys?.close().catch(() => undefined);
    await lock.close().catch(() => undefined);
    for (const path of [first, lockPath, join(directory, `${id}.keys`)])
      await unlink(path).catch(() => undefined);
    throw error;
  }
}

function heldLease(
  directory: string,
  id: string,
  lock: FileHandle,
  keys: FileHandle,
): Lease {
  let released = false;
  let broken: Error | undefined;
  return {
    id,
    async write(line) {
      if (broken !== undefined) throw broken;
      if (released || line.includes('\n'))
        throw new Error(`Cannot write ${JSON.stringify(line)} to lease ${id}`);
      const bytes = Buffer.from(`${line}\n`);
      const { bytesWritten } = await keys.write(bytes, 0, bytes.length);
      // Part of a line (a full disk) would join the next one, and that line
      // would be lost: the lease takes no more.
      if (bytesWritten !== bytes.length) {
        broken = new Error(
          `Lease ${id} took ${bytesWritten} of ${bytes.length} bytes of a line (is the disk full?), and takes no more`,
        );
        throw broken;
      }
    },
    async release() {
      if (released) return;
      released = true;
      // Keys first: from here on the lease protects nothing, so a reader that
      // finds the lock unheld before it is removed loses nothing by removing it.
      await keys.close();
      await unlink(join(directory, `${id}.keys`)).catch(() => undefined);
      // Windows cannot remove a file this process still holds unshared.
      await lock.close();
      await unlink(join(directory, `${id}.lock`)).catch(() => undefined);
      // The last lease out removes the directory; a busy one stays.
      await rmdir(directory).catch(() => undefined);
    },
  };
}

/** Whether a freshly opened lock is held the way its mechanism promises. */
async function holdsItself(
  lock: FileHandle,
  path: string,
  how: Mechanism,
): Promise<boolean> {
  switch (how) {
    case 'proc': {
      const [mine, seen] = await Promise.all([
        lock.stat(),
        stat(`/proc/self/fd/${lock.fd}`).catch(() => undefined),
      ]);
      return seen !== undefined && sameFile(seen, mine);
    }
    case 'flock':
      return (await openProbe(path, how)) === 'EAGAIN';
    case 'share':
      return (await openProbe(path, how)) === 'EBUSY';
    case 'pid':
      return true;
  }
}

/** Remove what is left of an abandoned lease. */
export async function removeLease(
  directory: string,
  id: string,
): Promise<void> {
  for (const file of ['keys', 'lock', 'pending'] as const)
    await unlink(join(directory, `${id}.${file}`)).catch(() => undefined);
}
