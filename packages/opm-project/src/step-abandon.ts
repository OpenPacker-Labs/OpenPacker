import { lstat, readdir, realpath } from 'node:fs/promises';
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
import { discardCopy } from './rollback-files.js';
import {
  copyId,
  foreignCopy,
  recoverHeldProject,
  type RecoveredStep,
} from './rollback-recovery.js';
import { otherProject, sharesOpmDir } from './rollback-project.js';
import {
  DISCARD_SUFFIX,
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
 * owner goes with it. What it does depends on what opm can know of the owner:
 *
 * - running here (its pid answers in this PID namespace): refused, always
 *   (`STEP_ALIVE`);
 * - provably dead (its boot has ended, or its pid is free here): done;
 * - of another place, which opm cannot judge: refused (`PROJECT_BUSY`) unless
 *   `force`, and the refusal says what it costs to be wrong: the step may be
 *   running, writing the project with its lock gone and its work undone;
 * - a lock that does not say who holds it (cut short, or from a newer opm):
 *   the same, and with `force` only that lock file is removed;
 * - a copy made in another project (`cp -a .opm`): only the copy is removed,
 *   never put back, and no confirmation is asked for.
 */
export interface AbandonOptions extends StepOptions {
  /** Take a step opm cannot judge to be dead; the operator's word, with its cost. */
  force?: boolean;
}

export interface AbandonedStep {
  /** The owner taken to be dead; absent for a lock that did not say who held it. */
  owner?: ProcessOwner;
  /** The lock files removed (the owner's, and any other that was gone). */
  removedLocks: readonly RemovedLock[];
  /** The copies put back or removed. */
  recovered: readonly RecoveredStep[];
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu;

/** A lock or a copy of `.opm`, and what opm can say of whose it is. */
interface Named {
  /** `.opm/<name>`, for messages. */
  file: string;
  name: string;
  kind: 'lock' | 'copy';
  /** Who made it; absent for a lock that does not say. */
  owner?: ProcessOwner;
  /** For a copy: the real path of the project it was made in, when that is not this one. */
  foreign?: string;
  /** Milliseconds since it was last written. */
  ageMs: number;
}

export async function abandonStep(
  root: string,
  id: string,
  options: AbandonOptions = {},
): Promise<AbandonedStep> {
  const paths = projectPaths(await realpath(root).catch(() => root));
  const named = await find(paths.root, paths.opmDir, id);
  const waitMs = parseStepWait(
    String(options.waitMs ?? DEFAULT_STEP_WAIT_MS),
    'The step wait',
  );
  const lockOptions = {
    waitMs,
    ...(!(options.onWait === undefined) && { onWait: options.onWait }),
  };
  if (named.foreign !== undefined) {
    // Not a step of this project: nothing of it is running here or needs
    // putting back, so there is nothing to confirm and nothing else to touch,
    // unless the project it belongs to has this very .opm.
    if (await sharesOpmDir(named.foreign, paths.opmDir))
      throw await foreignCopy(paths.root, named.name, named.foreign, true);
    const lock = await acquireStepLock(paths, lockOptions);
    try {
      await discardCopy(join(paths.opmDir, named.name));
      const step: RecoveredStep = {
        copy: named.file,
        owner: named.owner!,
        restored: false,
        foreign: named.foreign,
      };
      options.onRecovered?.(step);
      return {
        owner: named.owner!,
        removedLocks: lock?.removed ?? [],
        recovered: [step],
      };
    } finally {
      await lock?.release();
    }
  }
  const owner = named.owner;
  if (owner === undefined) {
    if (options.force !== true) throw unreadableLock(named);
    const lock = await acquireStepLock(paths, {
      ...lockOptions,
      abandonedFiles: new Set([named.name]),
    });
    try {
      const recovered = await recoverHeldProject(paths.root);
      for (const step of recovered) options.onRecovered?.(step);
      return { removedLocks: lock?.removed ?? [], recovered };
    } finally {
      await lock?.release();
    }
  }
  const place = ownerPlace(owner, await currentOwner());
  if (place === 'here' && (await isOwnerAlive(owner)))
    throw new OpmError(
      'STEP_ALIVE',
      `${describeProcessOwner(owner)} is running ${named.file} here: its pid answers in this PID namespace. Wait for it to finish, or stop it; opm will not call a running step dead.`,
    );
  if (place === 'elsewhere' && options.force !== true)
    throw unjudged(named, owner);
  const key = ownerKey(owner);
  const abandoned = (candidate: ProcessOwner) => ownerKey(candidate) === key;
  const lock = await acquireStepLock(paths, { ...lockOptions, abandoned });
  try {
    const recovered = await recoverHeldProject(
      paths.root,
      undefined,
      abandoned,
    );
    for (const step of recovered) options.onRecovered?.(step);
    return { owner, removedLocks: lock?.removed ?? [], recovered };
  } finally {
    await lock?.release();
  }
}

/** How long ago, for a message: the largest whole unit. */
function since(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'less than a minute ago';
  if (minutes < 120) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hours ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

/** A step opm cannot see: what asking to take it for dead costs, in plain words. */
function unjudged(named: Named, owner: ProcessOwner): OpmError {
  return new OpmError(
    'PROJECT_BUSY',
    `opm cannot tell whether the step of ${describeProcessOwner(owner)} (${named.file}, written ${since(named.ageMs)}) is still running: it is in another container, boot or host. Taking it for dead removes its lock and puts the project back as it was before that step. If that step is running, it keeps writing this project with its lock gone and its work undone. If you know it is not running, add --force to the same command.`,
  );
}

/** A lock that says nothing: what removing it costs, and that nothing else is touched. */
function unreadableLock(named: Named): OpmError {
  return new OpmError(
    'PROJECT_BUSY',
    `${named.file} (written ${since(named.ageMs)}) does not say who holds it: it was cut short, or a newer opm wrote it. opm cannot tell whether that step is running. Removing it lets other steps run on this project, and if that step is running it keeps writing without a lock. If you know no opm step is running on this project, add --force to remove that lock file; nothing else is changed.`,
  );
}

/**
 * The lock or copy in `.opm` that has `id`: the id a lock's name carries
 * (whatever it is), or a copy's, or one of those inside the text it was given.
 */
async function find(root: string, opmDir: string, id: string): Promise<Named> {
  const names = await readdir(opmDir).catch(() => [] as string[]);
  const wanted = id.trim().toLowerCase();
  const embedded = UUID.exec(id)?.[0]?.toLowerCase();
  const matches = (candidate: string | undefined) =>
    candidate !== undefined &&
    (candidate.toLowerCase() === wanted ||
      candidate.toLowerCase() === embedded);
  for (const name of names.sort()) {
    if (matches(stepLockId(name)))
      return describeEntry(opmDir, name, 'lock', await lockOwner(opmDir, name));
    if (name.startsWith(ROLLBACK_PREFIX) && matches(copyId(name))) {
      const record = await copyRecord(opmDir, name);
      const foreign =
        record.state === 'ready' && !name.endsWith(DISCARD_SUFFIX)
          ? await otherProject(root, record.project)
          : undefined;
      return {
        ...(await describeEntry(opmDir, name, 'copy', record.owner)),
        ...(!(foreign === undefined) && { foreign }),
      };
    }
  }
  if (
    embedded === undefined &&
    !names.some((name) => matches(stepLockId(name)))
  )
    throw new OpmError(
      'INVALID_SPEC',
      `${JSON.stringify(id)} is not the id of a step lock or copy; the refusal that brought you here prints it (step-<id>.lock, .rollback-<pid>-<id>)`,
    );
  throw new OpmError(
    'NOT_FOUND',
    `No step lock or copy with id ${wanted} in ${opmDir}; what is there is ${
      names
        .filter(
          (name) =>
            stepLockId(name) !== undefined || name.startsWith(ROLLBACK_PREFIX),
        )
        .join(', ') || 'neither'
    }`,
  );
}

async function describeEntry(
  opmDir: string,
  name: string,
  kind: 'lock' | 'copy',
  owner: ProcessOwner | undefined,
): Promise<Named> {
  const info = await lstat(join(opmDir, name)).catch(() => undefined);
  return {
    file: join('.opm', name),
    name,
    kind,
    ...(!(owner === undefined) && { owner }),
    ageMs: info === undefined ? 0 : Math.max(0, Date.now() - info.mtimeMs),
  };
}

/** Who holds the lock `name`; `undefined` where it does not say (empty, cut short, newer). */
async function lockOwner(
  opmDir: string,
  name: string,
): Promise<ProcessOwner | undefined> {
  try {
    // SAFETY: parsed below; anything unexpected is a lock that says nothing.
    const record = JSON.parse(
      await readStableFile(join(opmDir, name), 4096),
    ) as { lockVersion?: unknown; owner?: unknown };
    return record.lockVersion === 1
      ? parseProcessOwner(record.owner)
      : undefined;
  } catch {
    return undefined;
  }
}

async function copyRecord(opmDir: string, name: string) {
  try {
    const text = await readStableFile(
      join(opmDir, name, ROLLBACK_RECORD),
      1024 * 1024,
    );
    const record = parseRollbackRecord(JSON.parse(text));
    if (record !== undefined) return record;
  } catch {
    // Falls through to the same refusal: it says nothing about whose it is.
  }
  throw new OpmError(
    'INVALID_ROLLBACK',
    `.opm/${name} has no record opm can read, so it cannot tell whose step it is; remove it to keep the project as it is now`,
  );
}
