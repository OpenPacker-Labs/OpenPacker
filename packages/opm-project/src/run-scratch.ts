import { randomUUID } from 'node:crypto';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { currentOwner, isOwnerAlive, type RunOwner } from './run-owner.js';

/**
 * Directories a run makes for itself and removes when it ends: the store views
 * a sandbox binds, and the `node_modules` an ephemeral tool runs from.
 *
 * A run killed outright (SIGKILL, a crash, the power) never reaches the code
 * that removes them, so each name says which process made it (`run-owner.ts`),
 * and the next run that makes one in the same place, or `opm gc` for views,
 * removes those whose process has ended. One whose process may still be
 * running, or that another machine or PID namespace made, is never touched;
 * one an earlier boot of this machine made is removed.
 */

/** A name under `prefix` that belongs to this process. */
export function scratchName(prefix: string): string {
  return scratchNameFor(prefix, currentOwner());
}

/** A name under `prefix` that says `owner` made it. */
export function scratchNameFor(prefix: string, owner: RunOwner): string {
  const { machine, host, boot, pidNamespace, pid, start } = owner;
  return `${prefix}${[machine, host, boot, pidNamespace, pid, start].join('.')}-${randomUUID()}`;
}

/** Who made `name`, a name under `prefix`; undefined for any other name. */
function ownerOf(prefix: string, name: string): RunOwner | undefined {
  if (!name.startsWith(prefix)) return undefined;
  const [machine, host, boot, pidNamespace, pid, start, ...rest] = name
    .slice(prefix.length)
    .split('-')[0]!
    .split('.');
  const owner = Number(pid);
  if (
    rest.length > 0 ||
    start === undefined ||
    !Number.isSafeInteger(owner) ||
    owner <= 0
  )
    return undefined;
  return {
    machine: machine!,
    host: host!,
    boot: boot!,
    pidNamespace: pidNamespace!,
    pid: owner,
    start,
  };
}

/** Remove what processes that have ended left under `prefix` in `dir`. */
export async function sweepAbandoned(
  dir: string,
  prefix: string,
): Promise<void> {
  const names = await readdir(dir).catch(() => []);
  for (const name of names) {
    const owner = ownerOf(prefix, name);
    if (owner === undefined || isOwnerAlive(owner)) continue;
    await rm(join(dir, name), { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
}
