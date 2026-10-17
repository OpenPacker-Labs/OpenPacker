import { createHash, randomUUID } from 'node:crypto';
import { readdir, rm } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';

/**
 * Directories a run makes for itself and removes when it ends: the store views
 * a sandbox binds, and the `node_modules` an ephemeral tool runs from.
 *
 * A run stopped by a signal (Ctrl-C included) never reaches the code that
 * removes them, so each name says which process on which host made it, and the
 * next run that makes one in the same place removes those whose process has
 * ended. One whose process may still be running is never touched.
 */

/** This host, short: a name from another host is never judged here. */
const HOST = createHash('sha256').update(hostname()).digest('hex').slice(0, 8);

/** A name under `prefix` that belongs to this process. */
export function scratchName(prefix: string): string {
  return `${prefix}${HOST}-${process.pid}-${randomUUID()}`;
}

/** Remove what processes on this host that have ended left under `prefix` in `dir`. */
export async function sweepAbandoned(
  dir: string,
  prefix: string,
): Promise<void> {
  const names = await readdir(dir).catch(() => []);
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const [host, pid] = name.slice(prefix.length).split('-');
    const owner = Number(pid);
    if (host !== HOST || !Number.isSafeInteger(owner) || owner <= 0) continue;
    if (mayBeRunning(owner)) continue;
    await rm(join(dir, name), { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
}

/**
 * Whether `pid` may still be running. A pid reused by another process keeps
 * the leftover until that process ends too, which only delays removing it.
 */
function mayBeRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // SAFETY: only the errno code of a failed signal is read.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}
