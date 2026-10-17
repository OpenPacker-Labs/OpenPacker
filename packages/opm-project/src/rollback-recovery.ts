import { readdir, readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { projectPaths } from './paths.js';
import {
  DISCARD_SUFFIX,
  ROLLBACK_PREFIX,
  ROLLBACK_RECORD,
  discardCopy,
  restoreFrom,
  type RollbackRecord,
} from './project-rollback.js';
import { ownerMayBeAlive, type RollbackOwner } from './rollback-owner.js';

/** A copy a step left behind, and what was done with it. */
export interface RecoveredStep {
  /** The copy, relative to the project root. */
  copy: string;
  owner: RollbackOwner;
  /** True when the project was put back from it; false when it was only removed. */
  restored: boolean;
}

/**
 * Finish what a killed step left: a step that changes the project (`opm add`,
 * `remove`, `sync`, `update`, `install`, `ci`) runs this first.
 *
 * A copy whose owner may still be running is never touched. Of the rest, a
 * `ready` copy that was not being discarded means the project may be half way
 * through a step, so the project is put back from it; a copy that was still
 * being made (the step had not started writing) or was being discarded (the
 * step had finished) is only removed.
 */
export async function recoverInterruptedSteps(
  root: string,
): Promise<RecoveredStep[]> {
  const paths = projectPaths(root);
  const names = await readdir(paths.opmDir).catch(() => [] as string[]);
  const recovered: RecoveredStep[] = [];
  for (const name of names.sort()) {
    if (!name.startsWith(ROLLBACK_PREFIX)) continue;
    const holder = join(paths.opmDir, name);
    const record = await readRecord(holder);
    // A copy with no record yet was cut short as it was created; its name
    // carries the owner's pid.
    const owner = record?.owner ?? ownerFromName(name);
    if (owner === undefined || (await ownerMayBeAlive(owner))) continue;
    const restore = record?.state === 'ready' && !name.endsWith(DISCARD_SUFFIX);
    if (restore) await restoreFrom(paths.root, holder, record);
    else await discardCopy(holder);
    recovered.push({ copy: join('.opm', name), owner, restored: restore });
  }
  return recovered;
}

/** One line for each copy recovered, as `opm` prints it on stderr. */
export function describeRecovery(step: RecoveredStep): string {
  return step.restored
    ? `opm: put the project back as it was before a step that process ${step.owner.pid} did not finish, and removed ${step.copy}`
    : `opm: removed ${step.copy}, left by process ${step.owner.pid} before it changed the project`;
}

async function readRecord(holder: string): Promise<RollbackRecord | undefined> {
  try {
    // SAFETY: written by project-rollback.ts; its owner is checked before use.
    const record = JSON.parse(
      await readFile(join(holder, ROLLBACK_RECORD), 'utf8'),
    ) as RollbackRecord;
    return record.rollbackVersion === 1 && typeof record.owner?.pid === 'number'
      ? record
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The owner of a copy cut short before its record was written: the pid in its
 * name, on this machine (the record is the first thing written, so the window
 * is the one between creating the directory and writing it).
 */
function ownerFromName(name: string): RollbackOwner | undefined {
  const pid = Number(/^\.rollback-(\d+)-/u.exec(name)?.[1]);
  return Number.isSafeInteger(pid) && pid > 0
    ? { pid, host: hostname() }
    : undefined;
}
