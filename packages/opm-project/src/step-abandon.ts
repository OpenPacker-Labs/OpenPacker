import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { projectPaths, readStableFile } from './paths.js';
import {
  currentOwner,
  describeProcessOwner,
  isOwnerAlive,
  ownerKey,
  ownerPlace,
  parseProcessOwner,
  type ProcessOwner,
} from './process-owner.js';
import {
  type StepOptions,
  parseStepWait,
  DEFAULT_STEP_WAIT_MS,
} from './project-step.js';
import {
  copyId,
  recoverHeldProject,
  type RecoveredStep,
} from './rollback-recovery.js';
import {
  ROLLBACK_PREFIX,
  ROLLBACK_RECORD,
  parseRollbackRecord,
} from './rollback-record.js';
import { acquireStepLock, stepLockId, type RemovedLock } from './step-lock.js';
import { OpmError } from './types.js';

/**
 * The operator's way out of a step opm cannot judge (ADR 0056 §5): its owner is
 * in another PID namespace, boot or host (a container restarted over a
 * persisted project, a CI workspace reused), so its lock and its copy count as
 * running for ever. `opm recover --abandon-step <id>` says the step is dead:
 * its lock is removed and its copy put back, as if the owner had been seen to
 * be gone.
 *
 * <id> names a lock (`step-<id>.lock`) or a copy (`.rollback-<pid>-<id>`),
 * which the refusal that led here prints. Every lock and copy of the same
 * owner goes with it. It is refused for an owner that is here and running, or
 * a pid that answers in this PID namespace: that step is not dead. For an
 * owner of another place the assertion is the operator's, and it costs what
 * it would cost to be wrong: a step really running on another host, writing
 * the project while this one puts it back.
 */
export interface AbandonedStep {
  /** The owner taken to be dead. */
  owner: ProcessOwner;
  /** The lock files removed (the owner's, and any other that was gone). */
  removedLocks: readonly RemovedLock[];
  /** The copies put back or removed. */
  recovered: readonly RecoveredStep[];
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu;

export async function abandonStep(
  root: string,
  id: string,
  options: StepOptions = {},
): Promise<AbandonedStep> {
  const paths = projectPaths(root);
  const wanted = UUID.exec(id)?.[0]?.toLowerCase();
  if (wanted === undefined)
    throw new OpmError(
      'INVALID_SPEC',
      `${JSON.stringify(id)} is not the id of a step lock or copy; the refusal that brought you here prints it (step-<id>.lock, .rollback-<pid>-<id>)`,
    );
  const named = await find(paths.opmDir, wanted);
  const here = await currentOwner();
  if (
    ownerPlace(named.owner, here) === 'here' &&
    (await isOwnerAlive(named.owner))
  )
    throw new OpmError(
      'STEP_ALIVE',
      `${describeProcessOwner(named.owner)} is running ${named.file} here: its pid answers in this PID namespace. Wait for it to finish, or stop it; opm will not call a running step dead.`,
    );
  const key = ownerKey(named.owner);
  const abandoned = (owner: ProcessOwner) => ownerKey(owner) === key;
  const lock = await acquireStepLock(paths, {
    waitMs: parseStepWait(
      String(options.waitMs ?? DEFAULT_STEP_WAIT_MS),
      'The step wait',
    ),
    ...(!(options.onWait === undefined) && { onWait: options.onWait }),
    abandoned,
  });
  try {
    const recovered = await recoverHeldProject(
      paths.root,
      undefined,
      abandoned,
    );
    for (const step of recovered) options.onRecovered?.(step);
    return { owner: named.owner, removedLocks: lock?.removed ?? [], recovered };
  } finally {
    await lock?.release();
  }
}

/** The lock or copy in `.opm` that has `id`, and who made it. */
async function find(
  opmDir: string,
  id: string,
): Promise<{ file: string; owner: ProcessOwner }> {
  const names = await readdir(opmDir).catch(() => [] as string[]);
  for (const name of names.sort()) {
    const lock = stepLockId(name);
    if (lock?.toLowerCase() === id)
      return { file: join('.opm', name), owner: await lockOwner(opmDir, name) };
    if (name.startsWith(ROLLBACK_PREFIX) && copyId(name).toLowerCase() === id)
      return { file: join('.opm', name), owner: await copyOwner(opmDir, name) };
  }
  throw new OpmError(
    'NOT_FOUND',
    `No step lock or copy with id ${id} in ${opmDir}; what is there is ${
      names
        .filter(
          (name) =>
            stepLockId(name) !== undefined || name.startsWith(ROLLBACK_PREFIX),
        )
        .join(', ') || 'neither'
    }`,
  );
}

async function lockOwner(opmDir: string, name: string): Promise<ProcessOwner> {
  const unreadable = () =>
    new OpmError(
      'INVALID_ROLLBACK',
      `.opm/${name} does not say who holds it, so opm cannot tell whose step it is; an empty lock is taken over after 5 s, so run this again`,
    );
  try {
    // SAFETY: parsed below; anything unexpected is a lock that says nothing.
    const record = JSON.parse(
      await readStableFile(join(opmDir, name), 4096),
    ) as {
      lockVersion?: unknown;
      owner?: unknown;
    };
    const owner =
      record.lockVersion === 1 ? parseProcessOwner(record.owner) : undefined;
    if (owner === undefined) throw unreadable();
    return owner;
  } catch (error) {
    throw error instanceof OpmError ? error : unreadable();
  }
}

async function copyOwner(opmDir: string, name: string): Promise<ProcessOwner> {
  try {
    const text = await readStableFile(
      join(opmDir, name, ROLLBACK_RECORD),
      1024 * 1024,
    );
    const record = parseRollbackRecord(JSON.parse(text));
    if (record !== undefined) return record.owner;
  } catch {
    // Falls through to the same refusal: it says nothing about whose it is.
  }
  throw new OpmError(
    'INVALID_ROLLBACK',
    `.opm/${name} has no record opm can read, so it cannot tell whose step it is; remove it to keep the project as it is now`,
  );
}
