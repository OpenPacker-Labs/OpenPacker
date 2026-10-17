import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';

/**
 * Whose copy of a project a rollback copy is (`project-rollback.ts`), and
 * whether that process still runs.
 *
 * A pid alone is not an identity: once a process ends its id can be given to
 * another. Where the system says when a process started (Linux:
 * `/proc/<pid>/stat`, field 22), that is recorded too, and a process with the
 * same id and another start time is a different one. Where it does not, a live
 * process with the id counts as the owner, which can only keep a stale copy
 * waiting longer: it can never let a live copy be touched.
 */
export interface RollbackOwner {
  pid: number;
  host: string;
  /** Clock ticks after boot when the process started, where the system says. */
  startTime?: string;
}

export async function currentOwner(): Promise<RollbackOwner> {
  const startTime = await startTimeOf(process.pid);
  return {
    pid: process.pid,
    host: hostname(),
    ...(!(startTime === undefined) && { startTime }),
  };
}

/**
 * Whether the owner may still be running. A copy made on another machine (a
 * project on a shared disk) cannot be judged from here, so it counts as alive.
 */
export async function ownerMayBeAlive(owner: RollbackOwner): Promise<boolean> {
  if (owner.host !== hostname()) return true;
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    // EPERM: a process of another user has the id, which is alive.
    // SAFETY: only the errno code of the failed signal is read.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
  if (owner.startTime === undefined) return true;
  const now = await startTimeOf(owner.pid);
  return now === undefined || now === owner.startTime;
}

async function startTimeOf(pid: number): Promise<string | undefined> {
  if (process.platform !== 'linux') return undefined;
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    // `pid (comm) state ppid …`: comm may hold spaces and parentheses, so the
    // fields are counted from the last `)`. starttime is field 22, the 20th
    // after it.
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  } catch {
    return undefined;
  }
}
